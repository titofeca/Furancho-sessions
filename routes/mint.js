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
  const { walletAddress, ev } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }

  try {
    const { getVisitCount, openSession, getActiveEventWindow } = require('../db/database');

    // Anti-picaresca: el QR DEBE llevar la fecha del evento (ev=YYYY-MM-DD) y
    // coincidir con el evento activo. Sin fecha o fecha incorrecta → rechazado.
    const win = getActiveEventWindow();
    if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(ev)) {
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
    closeSession(walletAddress);
    _exitLocks.delete(walletAddress.toLowerCase());
    return res.json({ success: true, action: 'exit' });
  } catch (e) {
    _exitLocks.delete(walletAddress.toLowerCase());
    console.error('Error en /exit:', e.message);
    res.status(500).json({ error: 'Error al registrar salida' });
  }
});

// Lógica compartida de fichaje de ENTRADA — la usan /entry (cliente), /admin-checkin
// (admin) y /api/staff/checkin (camarero). UNA sola fuente para no divergir: abre sesión
// (openSession decide si cuenta como visita) y otorga el nivel por nº de visitas si contó.
function performCheckin(walletAddress, ipAddress) {
  const { getVisitCount, openSession } = require('../db/database');
  const result = openSession(walletAddress, false);
  const visitCount = getVisitCount(walletAddress);
  let levelUp = null;
  if (result.counted) {
    try { levelUp = awardLevelByVisits({ walletAddress, visitCount, ipAddress }); }
    catch (e) { console.error('Error otorgando nivel en check-in:', e.message); }
  }
  return {
    success: true,
    action: 'entry',
    isNew: visitCount === 1 && result.counted,
    visitCount,
    counted: !!result.counted,
    hasEventNow: result.hasEventNow !== false,
    levelUp
  };
}

// POST /api/mint/admin-checkin — el STAFF ficha la ENTRADA de un cliente que enseña su
// "ID Socio (QR)". Misma lógica exacta que /entry, pero autenticado y SIN el límite del
// endpoint público. Para clientes sin cámara o poco habituados: no usan su móvil.
router.post('/admin-checkin', requireAuth, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    return res.json(performCheckin(walletAddress, req.ip));
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
    closeSession(walletAddress);
    return res.json({ success: true, action: 'exit' });
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

    res.json({ levels, visitCount, hasActiveSession: !!activeSession, pendingApproval: pendingApproval || null, serialsByLevel, visits });
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
  try {
    const { createTransferRequest } = require('../db/transfers');
    const transferId = createTransferRequest(fromWallet, toWallet, parseInt(tokenId), privateKey);
    res.json({ success: true, transferId });
  } catch (e) {
    console.error('Error creando transfer request:', e);
    res.status(500).json({ error: 'Error al solicitar el traspaso' });
  }
});
// GET /api/mint/daily-tapa-status
// Comprueba el estado del canje de tapa/cunca de hoy para una wallet
router.get('/daily-tapa-status', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }

  try {
    const { db } = require('../db/database');
    const achievements = require('../services/achievements');
    
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const isJuly = today.split('-')[1] === '07';

    // 1. Verificar que estamos en julio
    if (!isJuly) {
      return res.json({
        eligible: false,
        claimed: false,
        reason: 'El beneficio de la Chave do Furancho solo está activo durante el mes de julio.'
      });
    }

    // 2. Verificar si tiene sesión iniciada hoy (fichaje obligatorio)
    const session = db.prepare(`
      SELECT id, entry_time FROM sessions 
      WHERE LOWER(wallet_address) = LOWER(?) 
        AND date(entry_time, '+2 hours') = ?
      ORDER BY entry_time DESC LIMIT 1
    `).get(wallet, today);

    if (!session) {
      return res.json({
        eligible: false,
        claimed: false,
        reason: 'No has fichado tu entrada hoy en el Furancho.'
      });
    }

    // 3. Buscar si posee el NFT "El Guardián da Chave" (guardian_furancho o IDs con 'guardian'/'chave')
    const queryAchievements = db.prepare(`
      WITH RankedMints AS (
        SELECT id, wallet_address, achievement_id, token_id, status,
               ROW_NUMBER() OVER (PARTITION BY achievement_id ORDER BY id ASC) as mint_serial
        FROM achievement_mints
        WHERE status = 'success'
      )
      SELECT * FROM RankedMints WHERE LOWER(wallet_address) = LOWER(?)
    `).all(wallet);

    const catalog = achievements.list();
    const eligibleNfts = [];

    queryAchievements.forEach(am => {
      const achId = am.achievement_id.toLowerCase();
      if (am.achievement_id === 'guardian_furancho' || achId.includes('guardian') || achId.includes('chave')) {
        const cat = catalog.find(c => c.id === am.achievement_id);
        eligibleNfts.push({
          type: 'achievement',
          id: am.achievement_id,
          name: cat ? cat.name : '🔑 Guardián de la Chave',
          tokenId: am.token_id,
          serial: am.mint_serial || 0
        });
      }
    });

    if (eligibleNfts.length === 0) {
      return res.json({
        eligible: false,
        claimed: false,
        reason: 'No tienes el NFT del Guardián de la Chave.'
      });
    }

    // 4. Comprobar si esta wallet ya ha canjeado hoy
    const walletClaim = db.prepare(`
      SELECT * FROM daily_tapa_claims 
      WHERE LOWER(wallet_address) = LOWER(?) AND claim_date = ?
    `).get(wallet, today);

    if (walletClaim) {
      let nftUsedName = '🔑 Guardián de la Chave';
      const cat = catalog.find(c => c.id === walletClaim.nft_id);
      if (cat) nftUsedName = cat.name;

      return res.json({
        eligible: true,
        claimed: true,
        claimedAt: walletClaim.claimed_at,
        nftUsed: {
          type: walletClaim.nft_type,
          id: walletClaim.nft_id,
          name: nftUsedName,
          serial: walletClaim.serial
        },
        reason: 'Ya has canjeado tu tapa y cunca de hoy.'
      });
    }

    // 5. Verificar que el NFT en particular no haya sido usado hoy por nadie más (anti-bypass por traspaso)
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

    if (availableNfts.length === 0) {
      return res.json({
        eligible: false,
        claimed: false,
        reason: 'Tu NFT del Guardián ya ha sido utilizado para canjear hoy en otra billetera.'
      });
    }

    // Seleccionamos el primer NFT disponible
    const activeNft = availableNfts[0];
    const qrData = `tapa_claim:${wallet}:achievement:${activeNft.id}:${activeNft.serial}:${today}`;

    res.json({
      eligible: true,
      claimed: false,
      activeNft,
      availableNfts,
      qrData
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.performCheckin = performCheckin;
