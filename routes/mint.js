require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Configuración de Rate Limiting (Máximo 10 peticiones por minuto por IP para evitar bots)
const mintLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 10,
  message: { error: 'Demasiadas peticiones. Inténtalo de nuevo en un minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const { Wallet } = require('ethers');
const { insertMint, updateMintStatus, checkDuplicate } = require('../db/database');
const { sendNftApprovalEmail } = require('../services/notifications');
const { requireAuth } = require('./admin'); // para el fichaje asistido por el staff

const LEVEL_NAMES = {
  1: 'Cautivo',
  2: 'O Cunqueiro',
  3: 'O Larpeiro',
  4: 'O Presidente do Furancho'
};

// Hitos de visitas → nivel. ÚNICA fuente de la regla de subida por visitas:
// 1ª visita = Nv1, 2ª = Nv2 (volver una vez), 4ª = Nv3, 12ª = Nv4.
const VISIT_LEVEL_THRESHOLDS = { 1: 1, 2: 2, 4: 3, 12: 4 };
const levelForVisitCount = (visitCount) => VISIT_LEVEL_THRESHOLDS[visitCount] || null;

// Otorga el nivel que toca por número de visitas (sin salto manual). Idempotente:
// si ya existe un pase no fallido de ese nivel, no hace nada (ni reinserta ni reenvía
// email). Reutilizado por POST /api/mint y por el fichaje in-app (/entry) para que
// VOLVER a un evento suba de nivel — antes /entry solo contaba la visita y el
// recurrente se quedaba en Nv1 aunque ya tuviera ≥2 visitas. Devuelve el pase
// otorgado { level, levelName, status } o null si no corresponde otorgar nada.
function awardLevelByVisits({ walletAddress, email = null, visitCount, ipAddress }) {
  const targetLevel = levelForVisitCount(visitCount);
  if (!targetLevel) return null;

  const { insertMint, db } = require('../db/database');

  // Idempotencia: si ya tiene este nivel (success) o lo tiene en cola (pending_approval),
  // no repetir — evita pases duplicados y emails de aprobación repetidos.
  const existing = db.prepare(
    `SELECT id FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status != 'failed' LIMIT 1`
  ).get(walletAddress, targetLevel);
  if (existing) return null;

  const levelName = LEVEL_NAMES[targetLevel];

  if (targetLevel <= 2) {
    // Nv1/Nv2 — off-chain, registro instantáneo (idéntico a POST /api/mint).
    insertMint({ email, level: targetLevel, levelName, walletAddress, status: 'success', ipAddress });
    try { require('../services/corcho').rewardLevelAward(walletAddress, targetLevel); } catch (_) {}
    return { level: targetLevel, levelName, status: 'success' };
  }

  // Nv3/Nv4 — requieren aprobación del admin antes de ir a blockchain.
  const mintId = insertMint({ email, level: targetLevel, levelName, walletAddress, status: 'pending_approval', ipAddress });
  const adminUrl = `${process.env.APP_URL || 'https://furancho-sessions-production.up.railway.app'}/admin`;
  sendNftApprovalEmail({ mintId, walletAddress, level: targetLevel, levelName, visitCount, adminUrl }).catch(() => {});
  return { level: targetLevel, levelName, status: 'pending_approval', mintId };
}



// POST /api/mint/entry — abre sesión y cuenta la visita en el momento de entrada
router.post('/entry', mintLimiter, async (req, res) => {
  const { walletAddress, ev, referrer } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }

  try {
    const { getVisitCount, openSession, getActiveEventWindow, db } = require('../db/database');

    // Registrar recomendación si existe — solo si el amigo es un cliente NUEVO
    // (sin visitas ni sesiones previas antes de hoy) y el referrer no se auto-refiere.
    if (referrer && /^0x[a-fA-F0-9]{40}$/i.test(referrer)
        && referrer.toLowerCase() !== walletAddress.toLowerCase()) {
      try {
        const refWallet  = referrer.toLowerCase();
        const newWallet  = walletAddress.toLowerCase();

        // 1. Comprobar que el amigo es realmente nuevo (ninguna visita/sesión previa)
        const hadPriorVisit = db.prepare(`
          SELECT 1 FROM (
            SELECT wallet_address FROM visits WHERE LOWER(wallet_address) = ?
            UNION
            SELECT wallet_address FROM sessions WHERE LOWER(wallet_address) = ? AND counted_as_visit = 1
          ) LIMIT 1
        `).get(newWallet, newWallet);

        // 2. Comprobar que el referrer tampoco está siendo referido por el amigo
        //    (evita intercambios circulares entre dos wallets)
        const isCircular = db.prepare(`
          SELECT 1 FROM referrals
          WHERE LOWER(referrer_wallet) = ? AND LOWER(referred_wallet) = ?
          LIMIT 1
        `).get(newWallet, refWallet);

        // 3. Límite anti-abuso: un referrer no puede tener más de 100 referidos registrados
        //    (frena bots que crean miles de wallets de un golpe)
        const referrerCount = db.prepare(`
          SELECT COUNT(*) as c FROM referrals WHERE LOWER(referrer_wallet) = ?
        `).get(refWallet);
        const tooMany = referrerCount && referrerCount.c >= 100;

        if (!hadPriorVisit && !isCircular && !tooMany) {
          const info = db.prepare(`
            INSERT OR IGNORE INTO referrals (referrer_wallet, referred_wallet)
            VALUES (?, ?)
          `).run(refWallet, newWallet);
          if (info.changes > 0) {
            try { require('../services/corcho').rewardReferral(refWallet, newWallet); } catch (_) {}
          }
        }
      } catch (err) {
        console.error('Error al registrar referido:', err.message);
      }
    }


    // Anti-picaresca: el QR DEBE llevar la fecha del evento (ev=YYYY-MM-DD) y
    // coincidir con el evento activo. Sin fecha o fecha incorrecta → rechazado.
    // NOTA: Si no viene parametro ev, se asume que es una llegada/acceso por enlace
    // de invitacion (onboarding/registro sin fichaje fisico).
    if (!ev) {
      return res.json({
        success: true,
        referralOnly: true,
        message: 'Invitación registrada correctamente.'
      });
    }

    const win = getActiveEventWindow();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev)) {
      return res.json({
        success: false, closed: true,
        message: 'Furancho pechado, ho. Este QR non ten data de evento.'
      });
    }
    if (!win || win.eventDayStr !== ev) {
      return res.json({
        success: false, closed: true,
        message: win
          ? `Este QR é da sesión do ${ev.split('-').reverse().join('/')}. Hoxe hai outra sesión, ho.`
          : 'Furancho pechado, ho. Hoxe non hai sesión na axenda.'
      });
    }

    // Abrir sesión — openSession decide si cuenta como visita:
    // solo si hay evento en la agenda ahora Y no hay otra visita contada esta semana
    const result = openSession(walletAddress, false);

    // Visit count post-entrada (ya incluye la visita de hoy si contó)
    const visitCount = getVisitCount(walletAddress);

    // Otorgar el nivel que corresponda por nº de visitas SOLO si esta entrada contó
    // como visita nueva (si no contó, no hay hito que celebrar). Idempotente: no
    // duplica pases. Esto es lo que hace que VOLVER suba de nivel desde el fichaje.
    let levelUp = null;
    if (result.counted) {
      try {
        levelUp = awardLevelByVisits({ walletAddress, visitCount, ipAddress: req.ip });
      } catch (e) {
        console.error('Error otorgando nivel en /entry:', e.message);
      }
    }

    // Mesa VIP de hoy: misma consecuencia que si le ficha el camarero o el admin.
    completeVipReservationOnCheckin(walletAddress);

    let pendingNftPrizes = [];
    try {
      const { getPendingNftPrizes } = require('../db/database');
      const achievements = require('../services/achievements');
      pendingNftPrizes = (getPendingNftPrizes(walletAddress) || []).map(r => {
        const a = achievements.getById(r.nft_achievement_id);
        return { prize: r.prize, name: a ? a.name : r.prize, image: a ? a.image : null };
      });
    } catch (_) {}

    return res.json({
      success: true,
      action: 'entry',
      isNew: visitCount === 1 && result.counted,
      visitCount,
      counted: !!result.counted,
      hasEventNow: result.hasEventNow !== false,
      alreadyCounted: !!result.alreadyVisitedThisWeek || !!result.alreadyOpen,
      levelUp,
      pendingNftPrizes,
      message: visitCount === 1 && result.counted
        ? '¡Benvido a Furancho Sessions!'
        : `¡Benvido de volta! Levas ${visitCount} visita${visitCount !== 1 ? 's' : ''}.`
    });
  } catch (error) {
    console.error('Error en /entry:', error.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/mint/exit — cierra sesión de forma dedicada (sin abrir nueva visita)
// Soluciona la race condition donde marcharDoFurancho(), fichaSalida() y autoRegistrarSalida()
// llamaban al mismo endpoint que la entrada, pudiendo generar visitas fantasma o dobles.
const _exitLocks = new Set(); // previene dobles salidas simultáneas por la misma wallet
router.post('/exit', mintLimiter, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress))
    return res.status(400).json({ error: 'Falta walletAddress' });

  if (_exitLocks.has(walletAddress.toLowerCase())) {
    return res.json({ success: true, action: 'already_processing' });
  }
  _exitLocks.add(walletAddress.toLowerCase());
  setTimeout(() => _exitLocks.delete(walletAddress.toLowerCase()), 5000);

  try {
    const { closeSession, db } = require('../db/database');
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL LIMIT 1`).get(walletAddress);
    if (!activeSession) {
      _exitLocks.delete(walletAddress.toLowerCase());
      return res.json({ success: true, action: 'no_session' });
    }
    const closedId = closeSession(walletAddress);
    // Recompensa en $CORCHO por fichar salida (idempotente por sesión).
    let corchoExit = null;
    if (closedId) {
      try { corchoExit = require('../services/corcho').rewardExit(walletAddress, closedId); } catch (_) {}
    }
    _exitLocks.delete(walletAddress.toLowerCase());
    return res.json({ success: true, action: 'exit', corchoExit });
  } catch (e) {
    _exitLocks.delete(walletAddress.toLowerCase());
    console.error('Error en /exit:', e.message);
    res.status(500).json({ error: 'Error al registrar salida' });
  }
});

// Lógica compartida de fichaje de ENTRADA — la usan /entry (cliente), /admin-checkin
// (admin) y /api/staff/checkin (camarero). UNA sola fuente para no divergir: abre sesión
// (openSession decide si cuenta como visita) y otorga el nivel por nº de visitas si contó.
// Si el cliente que acaba de fichar tenía mesa VIP confirmada para el evento de hoy,
// la damos por sentada ("completed"). Se llama desde LOS TRES caminos de fichaje
// (cliente, camarero y admin): antes solo lo hacían camarero y admin, así que quien
// fichaba solo con su app se quedaba eternamente en "confirmada" y el camarero no
// veía "EN MESA" al escanearle.
function completeVipReservationOnCheckin(walletAddress) {
  try {
    const { getActiveEventWindow, db, sendVipInboxNotification } = require('../db/database');
    const win = getActiveEventWindow();
    if (!win || !win.event) return;
    const row = db.prepare(`
      SELECT alias FROM vip_reservations
      WHERE LOWER(wallet_address) = LOWER(?) AND event_id = ? AND status = 'confirmed'
    `).get(walletAddress, win.event.id);
    if (!row) return;
    db.prepare(`
      UPDATE vip_reservations
      SET status = 'completed'
      WHERE LOWER(wallet_address) = LOWER(?) AND event_id = ? AND status = 'confirmed'
    `).run(walletAddress, win.event.id);
    sendVipInboxNotification(walletAddress, win.event.id, 'completed', row.alias);
  } catch (e) {
    console.error('Error al completar reserva VIP en checkin:', e.message);
  }
}

function performCheckin(walletAddress, ipAddress) {
  const { getVisitCount, openSession } = require('../db/database');
  const result = openSession(walletAddress, false);
  const visitCount = getVisitCount(walletAddress);
  let levelUp = null;
  let corchoReward = null;

  if (result.counted) {
    try { levelUp = awardLevelByVisits({ walletAddress, visitCount, ipAddress }); }
    catch (e) { console.error('Error otorgando nivel en check-in:', e.message); }

    try {
      const corcho = require('../services/corcho');
      // refId por DÍA (UTC) — MISMO esquema que el backfill (sessions.entry_time y
      // visits.event_date son UTC). Antes el vivo usaba event_<id> y el backfill
      // event_<fecha>: al no coincidir, la MISMA visita se acreditaba dos veces
      // (100 en vivo + 100 en el backfill). Con la misma clave se deduplica → 1 vez.
      const refId = `event_${new Date().toISOString().slice(0, 10)}`;
      corchoReward = corcho.rewardCheckin(walletAddress, refId);
    } catch (e) { console.error('Error recompensando CorchoCoins en check-in:', e.message); }
  }

  completeVipReservationOnCheckin(walletAddress);

  const payload = {
    success: true,
    action: 'entry',
    isNew: visitCount === 1 && result.counted,
    visitCount,
    counted: !!result.counted,
    hasEventNow: result.hasEventNow !== false,
    levelUp,
    corchoReward
  };

  // Aviso EN VIVO a la app del cliente por SSE: cuando el camarero (o el admin) le
  // ficha la entrada, su móvil se actualiza solo (botón → "Registrar Salida", badge
  // "Estás dentro") sin tener que refrescar a mano. Antes no cambiaba hasta recargar.
  try {
    require('./raffle').broadcastToEligible('checkin_done', {
      visitCount: payload.visitCount,
      counted: payload.counted,
      isNew: payload.isNew,
      hasEventNow: payload.hasEventNow
    }, [walletAddress]);
  } catch (_) {}

  return payload;
}


// POST /api/mint/admin-checkin — el STAFF ficha la ENTRADA de un cliente que enseña su
// "ID Socio (QR)". Misma lógica exacta que /entry, pero autenticado y SIN el límite del
// endpoint público. Para clientes sin cámara o poco habituados: no usan su móvil.
router.post('/admin-checkin', requireAuth, (req, res) => {
  const { walletAddress, campaignTs } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const result = performCheckin(walletAddress, req.ip);
    // "Reto de los 5": el panel cuenta la visita igual que el móvil del camarero,
    // con la MISMA exigencia de QR en vivo (services/campaign.js). Si el admin
    // escanea el ID Socio de siempre en vez del QR del reto, no suma — y el panel
    // se lo dice, para que nadie crea que ha sumado un sello que no existe.
    const campaign = require('../services/campaign');
    result.campaign = campaign.recordVisitFromScan(walletAddress, campaignTs);
    return res.json(result);
  } catch (error) {
    console.error('Error en /admin-checkin:', error.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/mint/admin-checkout — el STAFF ficha la SALIDA de un cliente. Igual que /exit.
router.post('/admin-checkout', requireAuth, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress))
    return res.status(400).json({ error: 'Falta walletAddress' });
  try {
    const { closeSession, db } = require('../db/database');
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL LIMIT 1`).get(walletAddress);
    if (!activeSession) return res.json({ success: true, action: 'no_session' });
    const closedId = closeSession(walletAddress);
    let corchoExit = null;
    if (closedId) {
      try { corchoExit = require('../services/corcho').rewardExit(walletAddress, closedId); } catch (_) {}
    }
    return res.json({ success: true, action: 'exit', corchoExit });
  } catch (e) {
    console.error('Error en /admin-checkout:', e.message);
    res.status(500).json({ error: 'Error al registrar salida' });
  }
});

// POST /api/mint/create-wallet
// Genera una billetera Web3 aleatoria con mnemónico de 12 palabras
router.post('/create-wallet', mintLimiter, (req, res) => {
  try {
    const wallet = Wallet.createRandom();
    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase || null   // 12 palabras BIP39
    });
  } catch (error) {
    console.error('Error al generar billetera:', error);
    res.status(500).json({ error: 'Error al generar la billetera anónima' });
  }
});

// POST /api/mint/register-install — marca la wallet como "tiene la app instalada".
// Se llama en silencio al crear/abrir la cuenta. AISLADO: no toca asistencia,
// sorteos ni niveles; solo alimenta el contador de furancheiros con app. Idempotente.
router.post('/register-install', mintLimiter, (req, res) => {
  const { walletAddress } = req.body || {};
  try {
    const { registerAppInstall } = require('../db/database');
    const r = registerAppInstall(walletAddress);
    res.json({ success: true, created: r.created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mint/recover-from-phrase
// Recupera una cuenta a partir de las 12 palabras mnemónicas
router.post('/recover-from-phrase', mintLimiter, (req, res) => {
  const { phrase } = req.body;
  if (!phrase || typeof phrase !== 'string') return res.status(400).json({ error: 'Falta la frase' });
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) return res.status(400).json({ error: 'La frase debe tener exactamente 12 palabras' });
  try {
    const wallet = Wallet.fromPhrase(words.join(' '));
    res.json({ address: wallet.address, privateKey: wallet.privateKey });
  } catch (e) {
    res.status(400).json({ error: 'Frase de recuperación no válida. Comprueba que las palabras son correctas.' });
  }
});

// POST /api/mint
// Body: { walletAddress, email, level (opcional para salto manual — requiere adminToken) }
router.post('/', mintLimiter, async (req, res) => {
  const { walletAddress, email, level, adminToken } = req.body;

  // Validaciones
  if (!walletAddress) {
    return res.status(400).json({ error: 'Dirección de billetera es obligatoria' });
  }

  // Validar formato de billetera EVM (0x...)
  const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!ethAddressRegex.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de billetera no válida' });
  }

  // Validar email si se proporciona
  let sanitizedEmail = null;
  if (email && email.trim() !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Formato de correo no válido' });
    }
    sanitizedEmail = email.toLowerCase().trim();
  }

  try {
    const { insertVisit, getVisitCount, checkRecentVisit, openSession, closeSession, clearStaleMint, db } = require('../db/database');
    

    // ==== CHECK COOLDOWN (Anti-Fraude) ====
    // No aplica a saltos de nivel manuales (level) para fines de demostración/admin,
    // ni tampoco si el usuario tiene una sesión activa abierta (es decir, está saliendo del evento).
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL LIMIT 1`).get(walletAddress);
    const hasActiveSession = !!activeSession;

    if (!level && !hasActiveSession && checkRecentVisit(walletAddress, 168)) {
      return res.status(429).json({
        error: 'Solo puedes acumular una visita por semana, ho. Vuelve la semana que viene.',
        action: 'cooldown'
      });
    }
    // ======================================

    // Registrar la visita actual
    closeSession(walletAddress);
    
    // Obtener total de visitas contando esta
    const visitCount = getVisitCount(walletAddress);

    // Determinar si corresponde un nivel por salto manual o por visitas
    let targetLevel = null;
    let manualLevel = parseInt(level);

    if (manualLevel && [1, 2, 3, 4].includes(manualLevel)) {
      // QR de regalo — no requiere adminToken para que los clientes puedan escanearlo libremente.
      // Si el cliente ya tiene el nivel solicitado, le subimos automáticamente al siguiente nivel libre.
      let requestedLevel = manualLevel;
      while (requestedLevel <= 4 && checkDuplicate(walletAddress, sanitizedEmail, requestedLevel)) {
        requestedLevel++;
      }
      if (requestedLevel > 4) {
        return res.status(409).json({ error: 'Ya tienes todos los pases hasta el Nivel Máximo.', action: 'duplicate' });
      }
      targetLevel = requestedLevel;
    } else {
      // Subida por visitas — misma regla única que usa el fichaje in-app (/entry):
      // 1ª=Nv1, 2ª=Nv2 (volver), 4ª=Nv3, 12ª=Nv4.
      targetLevel = levelForVisitCount(visitCount);
    }

    if (!targetLevel) {
      // No toca premio, solo registrar visita
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: `Visita ${visitCount} registrada correctamente.`
      });
    }

    const levelName = LEVEL_NAMES[targetLevel];

    // Verificar duplicado por seguridad en visitas normales
    if (!manualLevel && checkDuplicate(walletAddress, sanitizedEmail, targetLevel)) {
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: `Visita ${visitCount} registrada. Ya tenías el pase de este hito.`
      });
    }

    // Limpiar cualquier mint bloqueado (pending/failed) antes de insertar de nuevo
    clearStaleMint(walletAddress, targetLevel);

    if (targetLevel <= 2) {
      // Nv1/Nv2 — off-chain: registro instantáneo sin blockchain
      insertMint({ email: sanitizedEmail, level: targetLevel, levelName, walletAddress, status: 'success', ipAddress: req.ip });
      return res.json({
        success: true,
        action: 'level_up',
        visitCount,
        levelName,
        level: targetLevel,
        walletAddress,
        message: `¡Bienvenido al nivel ${levelName}!`
      });
    }

    // Nv3/Nv4 — requieren aprobación del admin antes de ir a blockchain
    const mintId = insertMint({ email: sanitizedEmail, level: targetLevel, levelName, walletAddress, status: 'pending_approval', ipAddress: req.ip });

    const adminUrl = `${process.env.APP_URL || 'https://furancho-sessions-production.up.railway.app'}/admin`;
    sendNftApprovalEmail({ mintId, walletAddress, level: targetLevel, levelName, visitCount, adminUrl }).catch(() => {});

    return res.json({
      success: true,
      action: 'pending_approval',
      visitCount,
      levelName,
      level: targetLevel,
      walletAddress,
      message: `¡Lo conseguiste, neno! Tu Tarjeta ${levelName} está siendo preparada. En breve es tuya.`
    });

  } catch (error) {
    console.error('❌ Error processando visita/mint:', error.message);
    return res.status(500).json({
      error: 'mint_failed',
      message: 'Error al procesar tu visita. Inténtalo de nuevo.'
    });
  }
});

// GET /api/mint/status/:actionId (opcional, para polling)
router.get('/status/:actionId', async (req, res) => {
  const { getMintStatus } = require('../services/crossmint');
  try {
    const status = await getMintStatus(req.params.actionId);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mint/history?wallet=0x...
router.get('/history', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Wallet es requerida' });
  try {
    const { getClaimedLevels, getVisitCount, db } = require('../db/database');
    const levels = getClaimedLevels(wallet);
    const visitCount = getVisitCount(wallet);
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL LIMIT 1`).get(wallet);
    const pendingApproval = db.prepare(`SELECT level, level_name FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND status = 'pending_approval' ORDER BY level DESC LIMIT 1`).get(wallet);
    // Número de serie por nivel (cuántos obtuvieron ese nivel antes que esta wallet)
    const serialsByLevel = {};
    levels.forEach(lvl => {
      const row = db.prepare(`SELECT mint_serial FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status != 'failed' LIMIT 1`).get(wallet, lvl);
      if (row?.mint_serial) serialsByLevel[lvl] = row.mint_serial;
    });

    const TZ = `'+2 hours'`;
    const visits = db.prepare(`
      SELECT day, (SELECT title FROM events WHERE event_date = day) as event_title
      FROM (
        SELECT date(entry_time, ${TZ}) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
        UNION
        SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(?)
      )
      ORDER BY day DESC
    `).all(wallet, wallet);

    // Estadísticas de referidos (Plan Amigo)
    let referral = null;
    try {
      // 1. Contar cuántos amigos ha invitado
      const referredCountRow = db.prepare(`
        SELECT COUNT(*) as count FROM referrals WHERE LOWER(referrer_wallet) = LOWER(?)
      `).get(wallet);
      const referredCount = referredCountRow ? referredCountRow.count : 0;

      // 2. Contar cuántos de esos amigos vinieron al furancho POR PRIMERA VEZ después de
      //    ser referidos (garantía de cliente nuevo). Se requiere que la visita sea
      //    posterior a la fecha del referral (r.created_at).
      const activeReferredFriendsRow = db.prepare(`
        SELECT COUNT(DISTINCT r.referred_wallet) as count
        FROM referrals r
        WHERE LOWER(r.referrer_wallet) = LOWER(?)
          AND (
            EXISTS (
              SELECT 1 FROM visits v
              WHERE LOWER(v.wallet_address) = LOWER(r.referred_wallet)
                AND v.visited_at >= r.created_at
            )
            OR EXISTS (
              SELECT 1 FROM sessions s
              WHERE LOWER(s.wallet_address) = LOWER(r.referred_wallet)
                AND s.counted_as_visit = 1
                AND s.entry_time >= r.created_at
            )
          )
      `).get(wallet);
      const activeReferredFriends = activeReferredFriendsRow ? activeReferredFriendsRow.count : 0;

      // 3. Créditos de bonos totales ganados (1 bono cada 15 amigos nuevos activos)
      const referralCredits = Math.floor(activeReferredFriends / 15);

      // 4. Bonos ya canjeados históricamente (registrados en daily_tapa_claims como tipo 'referral')
      const referralClaimsRow = db.prepare(`
        SELECT COUNT(*) as count FROM daily_tapa_claims
        WHERE LOWER(wallet_address) = LOWER(?) AND nft_type = 'referral'
      `).get(wallet);
      const referralClaims = referralClaimsRow ? referralClaimsRow.count : 0;

      const referralClaimsRemaining = Math.max(0, referralCredits - referralClaims);

      // 5. ¿Ha canjeado hoy?
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
      const claimedToday = !!db.prepare(`
        SELECT 1 FROM daily_tapa_claims
        WHERE LOWER(wallet_address) = LOWER(?) AND nft_type = 'referral' AND claim_date = ?
        LIMIT 1
      `).get(wallet, today);

      referral = {
        code: wallet.toLowerCase(),
        referredCount,
        activeReferredFriends,
        referralCredits,
        referralClaims,
        referralClaimsRemaining,
        claimedToday
      };
    } catch (e) {
      console.error('Error calculando referidos en /history:', e.message);
    }

    let sseRequired = false;
    try {
      sseRequired = db.prepare(`SELECT value FROM app_settings WHERE key = 'raffle_require_active_sse'`).get()?.value === '1';
    } catch (_) {}

    res.json({ levels, visitCount, hasActiveSession: !!activeSession, pendingApproval: pendingApproval || null, serialsByLevel, visits, referral, raffleRequireSse: sseRequired });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// GET /api/mint/transfer-settings
// Retorna las tarifas/peajes configurados para los traspasos de cada NFT
router.get('/transfer-settings', (req, res) => {
  try {
    const { getAppSetting } = require('../db/transfers');
    const achievements = require('../services/achievements');
    const fees = {};
    
    fees['level_1'] = getAppSetting('transfer_fee_1', '0');
    fees['level_2'] = getAppSetting('transfer_fee_2', '0');
    fees['level_3'] = getAppSetting('transfer_fee_3', '30');
    fees['level_4'] = getAppSetting('transfer_fee_4', '30');
    
    achievements.list().forEach(a => {
      fees[`ach_${a.id}`] = getAppSetting(`transfer_fee_ach_${a.id}`, '15');
    });

    res.json({ fees });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mint/transfer-request
// El cliente solicita un traspaso. Requiere enviar la privateKey temporalmente para que
// el servidor pueda firmar la transacción (pagando el gas el servidor) tras la aprobación.
router.post('/transfer-request', mintLimiter, (req, res) => {
  const { fromWallet, toWallet, tokenId, privateKey } = req.body;
  if (!fromWallet || !toWallet || !tokenId || !privateKey) {
    return res.status(400).json({ error: 'Faltan datos para el traspaso' });
  }
  if (!/^0x[a-fA-F0-9]{40}$/i.test(toWallet) || !/^0x[a-fA-F0-9]{40}$/i.test(fromWallet)) {
    return res.status(400).json({ error: 'La dirección destino o origen no es válida' });
  }
  if (fromWallet.toLowerCase() === toWallet.toLowerCase()) {
    return res.status(400).json({ error: 'No puedes traspasarte el NFT a ti mismo' });
  }
  try {
    // Anti-abuso: la clave enviada TIENE que corresponder a la wallet origen. Sin esto,
    // cualquiera podría encolar traspasos falsos que al aprobarse quemarían el POL de
    // gas del minter en transacciones que revierten on-chain.
    const { ethers } = require('ethers');
    let derived;
    try { derived = new ethers.Wallet(privateKey.trim()).address; } catch (_) {
      return res.status(400).json({ error: 'La clave de la cuenta no es válida' });
    }
    if (derived.toLowerCase() !== fromWallet.toLowerCase()) {
      return res.status(403).json({ error: 'La clave no corresponde a la wallet origen' });
    }

    // La wallet origen tiene que POSEER el NFT que quiere traspasar (según nuestro registro).
    const { db } = require('../db/database');
    const tid = parseInt(tokenId);
    let owns = false;
    if (tid >= 1 && tid <= 4) {
      owns = !!db.prepare(`SELECT 1 FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status = 'success'`).get(fromWallet, tid);
    } else {
      owns = !!db.prepare(`SELECT 1 FROM achievement_mints WHERE LOWER(wallet_address) = LOWER(?) AND token_id = ? AND status = 'success'`).get(fromWallet, tid);
    }
    if (!owns) {
      return res.status(403).json({ error: 'Esa wallet no posee este NFT' });
    }

    // Un solo traspaso pendiente por NFT y wallet: evita llenar la cola del patrón.
    const dupe = db.prepare(`SELECT 1 FROM nft_transfers WHERE LOWER(from_wallet) = LOWER(?) AND token_id = ? AND status = 'pending'`).get(fromWallet, tid);
    if (dupe) {
      return res.status(400).json({ error: 'Ya tienes un traspaso pendiente de este NFT. Espera a que el patrón lo gestione.' });
    }

    const { createTransferRequest } = require('../db/transfers');
    const transferId = createTransferRequest(fromWallet, toWallet, tid, privateKey.trim());
    res.json({ success: true, transferId });
  } catch (e) {
    console.error('Error creando transfer request:', e);
    res.status(500).json({ error: 'Error al solicitar el traspaso' });
  }
});
// FUENTE ÚNICA del estado del privilexio (tapa do día ligada a NFT) para una wallet.
// La usan: GET /api/mint/daily-tapa-status (tarjeta del cliente) y el check-in de
// staff (/api/staff/checkin), para que el camarero vea y consuma el privilexio al
// fichar al cliente. Misma lógica, mismos textos, mismo anti-trampa.
// Fecha (YYYY-MM-DD) en hora de Madrid de un timestamp de SQLite guardado en UTC.
// Misma conversión que usa openSession, para que "hoy" signifique lo mismo en todo
// el sistema tanto en horario de verano como de invierno.
function madridDateOf(sqlTimestamp) {
  if (!sqlTimestamp) return null;
  try {
    return new Date(String(sqlTimestamp).replace(' ', 'T') + 'Z')
      .toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  } catch (_) { return null; }
}

function computeDailyTapaStatus(wallet) {
    const { db } = require('../db/database');
    const achievements = require('../services/achievements');
    const { getAppSetting } = require('../db/transfers');

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

    // Configuración editable desde el panel admin (app_settings). El beneficio ya NO está
    // atado a julio a fuego: el admin decide si está activo, qué NFT lo desbloquea, la
    // ventana de fechas y cómo se llama de cara al cliente.
    const enabled = getAppSetting('daily_tapa_enabled', '0') === '1';
    // Uno o VARIOS NFTs dan el privilexio (lista separada por comas). El beneficio se
    // ACUMULA: cada NFT de la lista que posea el cliente = 1 tapa+cunca al día.
    // (Guardián + Chave d'Ouro = 2 tapas y 2 cuncas ese día.)
    const nftIds = String(getAppSetting('daily_tapa_nft', 'guardian_furancho'))
      .split(',').map(s => s.trim()).filter(Boolean);
    const fromDate = getAppSetting('daily_tapa_from', '');   // 'YYYY-MM-DD' o '' (sin límite)
    const toDate = getAppSetting('daily_tapa_to', '');       // 'YYYY-MM-DD' o '' (sin límite)

    const catalog = achievements.list();
    const nftNames = nftIds.map(id => { const c = catalog.find(x => x.id === id); return c ? c.name : id; });
    const nftName = nftNames.join('» + «') || 'NFT del Furancho';

    // Título, texto del beneficio y etiqueta del botón: configurables, con defaults que
    // dejan claro que va ligado a poseer el NFT.
    // `visible` controla si el cliente ve siquiera la tarjeta: solo la ve quien tiene el
    // NFT y con el beneficio activo. El resto (apagado, fuera de ventana o sin el NFT) no
    // la ve en absoluto.
    const meta = {
      title: getAppSetting('daily_tapa_title', 'Privilexio do Guardián'),
      benefit: getAppSetting('daily_tapa_benefit', 'Tapa e cunca do día'),
      button: getAppSetting('daily_tapa_button', '🎟️ Mostrar mi vale'),
      nftName
    };

    // 1. ¿Beneficio activo? (interruptor + ventana de fechas). Si no, el cliente ni lo ve.
    if (!enabled) {
      return ({ visible: false, eligible: false, claimed: false, ...meta, reason: `El privilexio do «${nftName}» no está activo ahora mismo.` });
    }
    if (fromDate && today < fromDate) {
      return ({ visible: false, eligible: false, claimed: false, ...meta, reason: `Este privilexio arranca el ${fromDate}.` });
    }
    if (toDate && today > toDate) {
      return ({ visible: false, eligible: false, claimed: false, ...meta, reason: `Este privilexio terminó el ${toDate}.` });
    }

    // 2. ¿Posee el NFT configurado que desbloquea el beneficio? Si no lo tiene, no ve la
    //    tarjeta (solo aparece a quien puede canjear algo). Se comprueba ANTES del fichaje.
    const queryAchievements = db.prepare(`
      WITH RankedMints AS (
        SELECT id, wallet_address, achievement_id, token_id, status,
               ROW_NUMBER() OVER (PARTITION BY achievement_id ORDER BY id ASC) as mint_serial
        FROM achievement_mints
        WHERE status = 'success'
      )
      SELECT * FROM RankedMints WHERE LOWER(wallet_address) = LOWER(?)
    `).all(wallet);

    const eligibleNfts = [];

    queryAchievements.forEach(am => {
      if (nftIds.includes(am.achievement_id)) {
        const cat = catalog.find(x => x.id === am.achievement_id);
        eligibleNfts.push({
          type: 'achievement',
          id: am.achievement_id,
          name: cat ? cat.name : am.achievement_id,
          tokenId: am.token_id,
          serial: am.mint_serial || 0
        });
      }
    });

    // 2.2. ¿Tiene créditos de Plan Amigo? Solo cuentan amigos NUEVOS que vinieron
    //      después de ser referidos (anti-trampa).
    const activeReferredFriendsRow = db.prepare(`
      SELECT COUNT(DISTINCT r.referred_wallet) as count
      FROM referrals r
      WHERE LOWER(r.referrer_wallet) = LOWER(?)
        AND (
          EXISTS (
            SELECT 1 FROM visits v
            WHERE LOWER(v.wallet_address) = LOWER(r.referred_wallet)
              AND v.visited_at >= r.created_at
          )
          OR EXISTS (
            SELECT 1 FROM sessions s
            WHERE LOWER(s.wallet_address) = LOWER(r.referred_wallet)
              AND s.counted_as_visit = 1
              AND s.entry_time >= r.created_at
          )
        )
    `).get(wallet);
    const activeReferredFriends = activeReferredFriendsRow ? activeReferredFriendsRow.count : 0;
    const referralCredits = Math.floor(activeReferredFriends / 15);

    const referralClaimsRow = db.prepare(`
      SELECT COUNT(*) as count FROM daily_tapa_claims 
      WHERE LOWER(wallet_address) = LOWER(?) AND nft_type = 'referral'
    `).get(wallet);
    const referralClaims = referralClaimsRow ? referralClaimsRow.count : 0;
    const referralClaimsRemaining = Math.max(0, referralCredits - referralClaims);

    const hasReferralCredits = referralClaimsRemaining > 0;
    const hasNft = eligibleNfts.length > 0;

    if (!hasNft && !hasReferralCredits) {
      return ({ visible: false, eligible: false, claimed: false, ...meta, reason: `Necesitas o bien el NFT «${nftName}» o bien invitar a 15 amigos activos para disfrutar este privilexio.` });
    }

    // 3. Tiene el NFT o créditos de referido: a partir de aquí SÍ ve la tarjeta.
    //    Verificar fichaje de hoy (obligatorio para canjear).
    //    entry_time se guarda en UTC. El desfase con Madrid es +2h en verano pero +1h
    //    en invierno, así que sumarle 2 fijas hacía que a partir de las 23:00 de un
    //    día de invierno el fichaje contase como "de mañana" y la tarjeta volviese a
    //    pedir "ficha tu entrada". Comparamos la fecha ya convertida a Madrid.
    const session = db.prepare(`
      SELECT id, entry_time FROM sessions
      WHERE LOWER(wallet_address) = LOWER(?)
      ORDER BY entry_time DESC LIMIT 1
    `).get(wallet);
    const sessionIsToday = session && madridDateOf(session.entry_time) === today;

    if (!sessionIsToday) {
      return ({ visible: true, eligible: false, claimed: false, ...meta, reason: 'Ficha tu entrada hoy en el Furancho para activarlo.' });
    }

    // 4. Canjes de HOY de esta wallet. El privilexio se ACUMULA: cada NFT de la
    //    lista que posea = 1 canje al día (más el bono Plan Amigo, máx. 1 al día).
    const walletClaimsToday = db.prepare(`
      SELECT * FROM daily_tapa_claims
      WHERE LOWER(wallet_address) = LOWER(?) AND claim_date = ?
      ORDER BY claimed_at ASC
    `).all(wallet, today);

    // 5. NFTs aún canjeables hoy (cada NFT concreto id+serie solo se usa 1 vez al día)
    const availableNfts = [];
    for (const nft of eligibleNfts) {
      const nftClaim = db.prepare(`
        SELECT id FROM daily_tapa_claims
        WHERE nft_type = 'achievement' AND nft_id = ? AND serial = ? AND claim_date = ?
      `).get(nft.id, nft.serial, today);

      if (!nftClaim) {
        availableNfts.push(nft);
      }
    }

    // Bono Plan Amigo: acumulable con los NFTs, pero máximo 1 bono amigo al día.
    const referralUsedToday = walletClaimsToday.some(c => c.nft_type === 'referral');
    if (hasReferralCredits && !referralUsedToday) {
      availableNfts.push({
        type: 'referral',
        id: 'referral',
        name: 'Bono Plan Amigo 🍇',
        tokenId: 0,
        serial: 0
      });
    }

    const activeNft = availableNfts.length > 0 ? availableNfts[0] : null;
    const qrData = activeNft
      ? `tapa_claim:${wallet}:${activeNft.type}:${activeNft.id}:${activeNft.serial}:${today}`
      : null;
    const claimedTodayCount = walletClaimsToday.length;
    const remainingToday = availableNfts.length;

    // Todos los canjes de hoy gastados → consumido (indicando cuántos fueron)
    if (!activeNft && claimedTodayCount > 0) {
      const last = walletClaimsToday[walletClaimsToday.length - 1];
      let nftUsedName = nftName;
      if (last.nft_type === 'referral') {
        nftUsedName = 'Bono Plan Amigo 🍇';
      } else {
        const cat = catalog.find(c => c.id === last.nft_id);
        if (cat) nftUsedName = cat.name;
      }

      return ({
        visible: true,
        eligible: true,
        claimed: true,
        ...meta,
        claimedAt: last.claimed_at,
        claimedToday: claimedTodayCount,
        remainingToday: 0,
        totalToday: claimedTodayCount,
        nftUsed: {
          type: last.nft_type,
          id: last.nft_id,
          name: nftUsedName,
          serial: last.serial
        },
        reason: claimedTodayCount > 1
          ? `Ya has canjeado tus ${claimedTodayCount} tapas y cuncas de hoy (una por NFT).`
          : 'Ya has canjeado tu tapa y cunca de hoy.'
      });
    }

    if (!activeNft) {
      return ({
        visible: true,
        eligible: false,
        claimed: false,
        ...meta,
        claimedToday: 0,
        remainingToday: 0,
        totalToday: 0,
        reason: hasNft ? `Tu «${nftName}» ya se usó hoy para un canje en otra billetera.` : 'No te quedan bonos de recomendados disponibles hoy.'
      });
    }

    return ({
      visible: true,
      eligible: true,
      claimed: false,
      ...meta,
      activeNft,
      availableNfts,
      qrData,
      claimedToday: claimedTodayCount,
      remainingToday,
      totalToday: claimedTodayCount + remainingToday
    });

}

// GET /api/mint/daily-tapa-status
// Comprueba el estado del canje de tapa/cunca de hoy para una wallet (delega en la fuente única)
router.get('/daily-tapa-status', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }
  try {
    res.json(computeDailyTapaStatus(wallet));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.performCheckin = performCheckin;
module.exports.computeDailyTapaStatus = computeDailyTapaStatus;
