const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  getEligibleRaffleParticipants, insertRaffle, acceptRaffle, rejectRaffle,
  collectRaffle, redeemRaffleByWinner, getRaffleHistory, getMyWins, getRaffleParticipation, getRaffleById,
  getPrizePresets, addPrizePreset, deletePrizePreset,
  getWeeklyPrizeTemplates, addWeeklyPrizeTemplate, updateWeeklyPrizeTemplate, deleteWeeklyPrizeTemplate,
  getRaffleCountTonight,
  getScheduledRaffles, createScheduledRaffle, updateScheduledRaffle,
  deleteScheduledRaffle, linkScheduledRaffle, insertMint,
  claimWeeklyRaffle, getWeeklyRaffleStatus, updateWeeklyPrize, drawWeeklyRaffle, collectWeeklyRaffle, collectWeeklyWinner, forfeitWeeklyRaffle,
  getWeeklyRaffleTargetWeek, forfeitExpiredWeeklyRaffles, isWeeklyWindowOpen,
  insertWeeklyChatMessage, getWeeklyChatMessages, markWeeklyChatRead, getWeeklyChatThreads,
  getWeeklyMessageViewCount, getWeeklyMessageViewCounts, UPLOADS_DIR
} = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll, sendPushToWallet, sendPushToWallets } = require('../services/push');
const { notifyQueue } = require('../services/polygon');

// Configuración de upload de imágenes de premio. Se guardan en el directorio
// PERSISTENTE (volumen de Railway), no en public/, para que no se borren al deployar.
const uploadsDir = UPLOADS_DIR;
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `prize_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máx
  fileFilter: (req, file, cb) => {
    // Solo JPG/PNG: son los formatos que se pueden incrustar en el PDF del bono.
    // (webp se ve en el navegador pero pdfkit no lo soporta → logo ausente en el PDF)
    if (/image\/(jpeg|jpg|png)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG o PNG (el webp no sale en el PDF del bono)'));
  }
});

let clients = [];

// Estado del sorteo activo — se rellena en doLaunch y se limpia al terminar.
// Permite que clientes que abran la app tarde reciban el estado actual al conectar.
let activeRaffle = null;
// { raffleId, displayPrize, prize, type, phase: 'start'|'result',
//   eligibleWallets: Set<string>, prizeDetails, prizeImage, establishment,
//   winnerWallet?, verificationCode?, acceptWindow?, startedAt }

// Envía evento SSE a TODOS los clientes conectados (o solo a uno por wallet)
function broadcast(event, data, targetWallet = null) {
  const dead = [];
  let targets = clients;
  if (targetWallet) {
    let lowerTargets = [];
    if (typeof targetWallet === 'string') {
      try {
        const parsed = JSON.parse(targetWallet);
        if (Array.isArray(parsed)) {
          lowerTargets = parsed.map(w => w.toLowerCase());
        } else {
          lowerTargets = [targetWallet.toLowerCase()];
        }
      } catch (e) {
        lowerTargets = [targetWallet.toLowerCase()];
      }
    } else if (Array.isArray(targetWallet)) {
      lowerTargets = targetWallet.map(w => w.toLowerCase());
    } else {
      lowerTargets = [targetWallet.toString().toLowerCase()];
    }
    targets = clients.filter(c => c.walletAddress && lowerTargets.includes(c.walletAddress.toLowerCase()));
  }
  targets.forEach(client => {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof client.res.flush === 'function') client.res.flush();
    } catch (e) {
      dead.push(client.id);
    }
  });
  if (dead.length) clients = clients.filter(c => !dead.includes(c.id));
}

// Envía evento SSE SOLO a los clientes cuya wallet está en la lista de elegibles
function broadcastToEligible(event, data, walletSet) {
  const dead = [];
  const lowercaseWalletSet = new Set([...walletSet].map(w => w.toLowerCase()));
  clients.filter(c => c.walletAddress && lowercaseWalletSet.has(c.walletAddress.toLowerCase())).forEach(client => {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof client.res.flush === 'function') client.res.flush();
    } catch (e) {
      dead.push(client.id);
    }
  });
  if (dead.length) clients = clients.filter(c => !dead.includes(c.id));
}

// Envía evento SSE a todos los administradores conectados
function broadcastToAdmins(event, data) {
  const dead = [];
  const admins = clients.filter(c => c.isAdmin);
  admins.forEach(client => {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof client.res.flush === 'function') client.res.flush();
    } catch (e) {
      dead.push(client.id);
    }
  });
  if (dead.length) clients = clients.filter(c => !dead.includes(c.id));
}

// GET /api/raffle/stream?wallet=0x...
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write('data: {"connected": true}\n\n');

  const clientId = Date.now() + Math.random();
  const walletAddress = req.query.wallet || null;
  const isAdmin = req.query.admin === 'true';
  const newClient = { id: clientId, res, walletAddress, isAdmin };

  // Cap: máximo 500 conexiones SSE activas para evitar memory leaks
  if (clients.length >= 500) {
    const oldest = clients.shift();
    try { oldest.res.end(); } catch (_) {}
  }
  clients.push(newClient);

  // Si hay un sorteo activo y esta wallet es elegible → enviar estado inmediatamente
  // (cubre el caso de clientes que abren la app tarde)
  const hasEligible = activeRaffle && walletAddress && [...activeRaffle.eligibleWallets].some(w => w.toLowerCase() === walletAddress.toLowerCase());
  if (hasEligible) {
    try {
      if (activeRaffle.phase === 'start') {
        // Duración restante real de la animación (10s totales) para que todos los
        // clientes vean el resultado a la vez
        const elapsed = Math.floor((Date.now() - activeRaffle.startedAt) / 1000);
        res.write(`event: raffle_start\ndata: ${JSON.stringify({
          duration: Math.max(1, 10 - elapsed), prize: activeRaffle.displayPrize, raffleId: activeRaffle.raffleId, type: activeRaffle.type,
          validity: activeRaffle.validity || null, people: activeRaffle.people || null, hours: activeRaffle.hours || null, days: activeRaffle.days || null
        })}\n\n`);
      } else if (activeRaffle.phase === 'result') {
        res.write(`event: raffle_result\ndata: ${JSON.stringify({
          winnerWallet: activeRaffle.winnerWallet, verificationCode: activeRaffle.verificationCode,
          prize: activeRaffle.prize, raffleId: activeRaffle.raffleId,
          acceptWindow: Math.max(0, activeRaffle.acceptWindow - Math.floor((Date.now() - activeRaffle.resultAt) / 1000)),
          type: activeRaffle.type, prizeDetails: activeRaffle.prizeDetails || null,
          prizeImage: activeRaffle.prizeImage || null, establishment: activeRaffle.establishment || null,
          validity: activeRaffle.validity || null, people: activeRaffle.people || null, hours: activeRaffle.hours || null, days: activeRaffle.days || null
        })}\n\n`);
      }
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {}
  }

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {
      clearInterval(keepalive);
      clients = clients.filter(c => c.id !== clientId);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepalive);
    clients = clients.filter(c => c.id !== clientId);
  });
});

// ── FUNCIÓN CENTRAL DE LANZAMIENTO (usada por /start, /launch-scheduled y auto-launcher) ────
function doLaunch({ prize, type = 'night', targetLevel = null, participantLevel = null, prizeDetails = null, prizeImage = null, establishment = null, hideName = false, scheduledId = null, requiredAchievement = null, validity = null, people = null, hours = null, days = null, validityEndDate = null, nftAchievementId = null }) {
  const sanitizedTargetLevel = targetLevel ? parseInt(targetLevel) : null;
  if (sanitizedTargetLevel && ![2, 3, 4].includes(sanitizedTargetLevel)) {
    throw new Error('Nivel de destino no válido. Debe ser 2, 3 o 4.');
  }
  const sanitizedParticipantLevel = participantLevel ? parseInt(participantLevel) : null;

  // Elegibles = TODOS los que ficharon entrada hoy y no han salido (sin requisito de app abierta)
  let eligibleWallets = getEligibleRaffleParticipants();

  // Sorteo VIP: solo participan "O Presidente" (Nivel 4)
  if (type === 'vip') {
    const { db } = require('../db/database');
    const vipWallets = new Set(
      db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE level = 4 AND status != 'failed'`).all().map(r => r.wallet_address)
    );
    eligibleWallets = eligibleWallets.filter(w => vipWallets.has(w));
    if (eligibleWallets.length === 0) throw new Error('No hay furancheiros O Presidente presentes esta noche.');
  }

  // Filtro por nivel mínimo de participante
  if (sanitizedParticipantLevel) {
    const { db } = require('../db/database');
    const levelWallets = new Set(
      db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE level >= ? AND status != 'failed'`).all(sanitizedParticipantLevel).map(r => r.wallet_address)
    );
    eligibleWallets = eligibleWallets.filter(w => levelWallets.has(w));
    if (eligibleWallets.length === 0) throw new Error(`No hay participantes de nivel ${sanitizedParticipantLevel}+ presentes en el local.`);
  }

  // Filtro por logro NFT requerido
  if (requiredAchievement) {
    const { db } = require('../db/database');
    const achWallets = new Set(
      db.prepare(`SELECT DISTINCT LOWER(wallet_address) w FROM achievement_mints WHERE achievement_id = ? AND status != 'failed'`).all(requiredAchievement).map(r => r.w)
    );
    eligibleWallets = eligibleWallets.filter(w => achWallets.has(String(w).toLowerCase()));
    if (eligibleWallets.length === 0) throw new Error('No hay participantes con el logro requerido presentes en el local.');
  }

  if (eligibleWallets.length === 0) throw new Error('No hay clientes con entrada fichada en el local.');

  // Doble Oportunidad para los ganadores de La Chave Semanal
  try {
    const { db } = require('../db/database');
    const weekStr = getWeeklyRaffleTargetWeek();
    const weeklyWinner = db.prepare(`SELECT winner_wallet FROM weekly_raffles WHERE claimed_week = ? AND status = 'completed'`).get(weekStr)?.winner_wallet;
    if (weeklyWinner) {
      let weeklyWinners = [];
      try {
        weeklyWinners = JSON.parse(weeklyWinner);
        if (!Array.isArray(weeklyWinners)) weeklyWinners = [weeklyWinner];
      } catch(e) {
        weeklyWinners = [weeklyWinner];
      }
      weeklyWinners.forEach(w => {
        if (w && eligibleWallets.includes(w)) {
          eligibleWallets.push(w);
          console.log(`[Raffle] Doble oportunidad para Chave Semanal: ${w.slice(0,6)}...`);
        }
      });
    }
  } catch (e) {}

  const eligibleSet = new Set(eligibleWallets);
  const connectedCount = clients.filter(c => c.walletAddress && eligibleSet.has(c.walletAddress)).length;

  const winnerWallet = eligibleWallets[Math.floor(Math.random() * eligibleWallets.length)];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let verificationCode = '';
  for (let i = 0; i < 4; i++) verificationCode += chars.charAt(Math.floor(Math.random() * chars.length));

  const raffleId = insertRaffle(prize, winnerWallet, verificationCode, eligibleWallets, sanitizedTargetLevel, prizeDetails, prizeImage, establishment, type, hideName ? 1 : 0, sanitizedParticipantLevel, validity, people, hours, days, validityEndDate, nftAchievementId || null);
  if (scheduledId) { try { linkScheduledRaffle(parseInt(scheduledId), raffleId); } catch(_) {} }

  const displayPrize = hideName ? 'Sorpresa 🎁' : prize;
  console.log(`[Raffle] #${raffleId} (${type}) iniciado. Participantes: ${eligibleWallets.length}, con app: ${connectedCount}`);

  // Guardar estado activo para que los clientes que abran la app tarde reciban el estado
  activeRaffle = {
    raffleId, prize, displayPrize, type, phase: 'start',
    eligibleWallets: eligibleSet,
    prizeDetails: prizeDetails || null, prizeImage: prizeImage || null, establishment: establishment || null,
    validity: validity || null, people: people || null, hours: hours || null, days: days || null,
    startedAt: Date.now()
  };

  // Solo enviar SSE a los elegibles (quienes ficharon entrada hoy)
  broadcastToEligible('raffle_start', { duration: 10, prize: displayPrize, raffleId, type, validity, people, hours, days }, eligibleSet);
  // Push SOLO a los fichados en el local — nunca a gente en casa. Texto neutro:
  // es un AVISO de que empieza el sorteo, no de que les haya tocado.
  sendPushToWallets([...eligibleSet], '🎰 ¡Empieza el sorteo en el Furancho!', 'Abre la app para entrar al bombo y ver si te toca, neno 🍷', {
    url: '/claim',
    image: prizeImage || '/assets/logo.png',
    actions: [{ action: 'open', title: 'Entrar al bombo 🎲' }],
  });

  setTimeout(() => {
    const resultData = { winnerWallet, verificationCode, prize, raffleId, acceptWindow: 600, type,
      prizeDetails: prizeDetails || null, prizeImage: prizeImage || null, establishment: establishment || null,
      validity: validity || null, people: people || null, hours: hours || null, days: days || null };
    broadcastToEligible('raffle_result', resultData, eligibleSet);
    // Actualizar estado activo con resultado
    if (activeRaffle?.raffleId === raffleId) {
      activeRaffle = { ...activeRaffle, phase: 'result', winnerWallet, verificationCode, acceptWindow: 600, resultAt: Date.now() };
    }
  }, 10000);

  setTimeout(() => {
    try {
      const { db } = require('../db/database');
      const raffle = db.prepare(`SELECT status FROM raffles WHERE id = ?`).get(raffleId);
      if (raffle?.status === 'pending_acceptance') {
        rejectRaffle(raffleId, 'Tiempo de aceptación agotado');
        broadcastToEligible('raffle_timeout', { raffleId, prize }, eligibleSet);
        console.log(`[Raffle] #${raffleId} rechazado automáticamente — tiempo agotado`);
      }
    } catch (e) { console.error('[Raffle] Error en auto-rechazo:', e.message); }
    // Limpiar estado activo
    if (activeRaffle?.raffleId === raffleId) activeRaffle = null;
  }, 610000);

  return { raffleId, winnerWallet, verificationCode, participants: eligibleWallets.length, prize, acceptWindow: 600 };
}

// POST /api/raffle/upload-image — sube imagen del premio (admin)
router.post('/upload-image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const url = `/prize-images/${req.file.filename}`;
  res.json({ success: true, url });
});

// POST /api/raffle/start — admin lanza sorteo manualmente con todos los datos
router.post('/start', requireAuth, (req, res) => {
  const { prize, scheduledId, targetLevel, participantLevel, prizeDetails, prizeImage, establishment, type, hideName, requiredAchievement, validity, people, hours, days, validityEndDate, nftAchievementId } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });
  try {
    const result = doLaunch({ prize, type: type || 'night', targetLevel, participantLevel, prizeDetails, prizeImage, establishment, hideName: !!hideName, scheduledId, requiredAchievement: requiredAchievement || null, validity, people, hours, days, validityEndDate, nftAchievementId: nftAchievementId || null });
    return res.json({ success: true, ...result });
  } catch(e) {
    return res.status(400).json({ error: e.message });
  }
});

// POST /api/raffle/launch-scheduled/:id — lanza un sorteo programado directamente por ID (admin + auto-launcher)
router.post('/launch-scheduled/:id', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const s = db.prepare(`SELECT * FROM scheduled_raffles WHERE id = ?`).get(parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Sorteo programado no encontrado' });
    if (s.status !== 'pending') return res.status(400).json({ error: 'Este sorteo ya fue lanzado o cancelado' });
    const result = doLaunch({
      prize: s.prize, type: s.type || 'night', targetLevel: s.target_level, participantLevel: s.participant_level,
      prizeDetails: s.prize_details, prizeImage: s.prize_image, establishment: s.establishment,
      hideName: s.hide_name ? true : false, scheduledId: s.id, requiredAchievement: s.required_achievement || null,
      validity: s.validity, people: s.people, hours: s.hours, days: s.days, validityEndDate: s.validity_end_date,
      nftAchievementId: s.nft_achievement_id || null
    });
    return res.json({ success: true, ...result });
  } catch(e) {
    return res.status(400).json({ error: e.message });
  }
});

// POST /api/raffle/:id/accept — ganador acepta el premio (público, valida wallet)
router.post('/:id/accept', (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    const raffle = acceptRaffle(parseInt(req.params.id), wallet);
    // Notificar al admin via SSE broadcast
    broadcast('raffle_accepted', { raffleId: parseInt(req.params.id) });
    if (activeRaffle?.raffleId === parseInt(req.params.id)) activeRaffle = null;

    // Si el sorteo tiene configurado un nivel de destino, encolar el minting Polygon
    if (raffle && raffle.target_level) {
      const LEVEL_NAMES = {
        1: 'Cautivo',
        2: 'O Cunqueiro',
        3: 'O Larpeiro',
        4: 'O Presidente do Furancho'
      };
      const levelName = LEVEL_NAMES[raffle.target_level];

      insertMint({
        email: null,
        level: raffle.target_level,
        levelName,
        walletAddress: wallet,
        status: 'pending',
        ipAddress: req.ip
      });

      notifyQueue();

      return res.json({
        success: true,
        targetLevel: raffle.target_level,
        levelName
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/raffle/:id/reject — admin rechaza (no cobró / no respondió)
router.post('/:id/reject', requireAuth, (req, res) => {
  const { note } = req.body;
  try {
    const rejId = parseInt(req.params.id);
    rejectRaffle(rejId, note || 'Rechazado por admin');
    broadcast('raffle_rejected', { raffleId: rejId });
    if (activeRaffle?.raffleId === rejId) activeRaffle = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/raffle/eligible-check?wallet=0x... — público, sesión hoy + sorteos de esta noche
router.get('/eligible-check', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    const { db } = require('../db/database');
    // Misma lógica única: elegible = fichó entrada dentro de la ventana de un evento de la agenda
    const eligibleSet = new Set(getEligibleRaffleParticipants().map(w => w.toLowerCase()));
    const isEligible = eligibleSet.has(wallet.toLowerCase());
    const rafflesDone = db.prepare(
      `SELECT COUNT(*) as count FROM raffles WHERE date(created_at) = date('now')`
    ).get()?.count || 0;
    res.json({ hasSessionToday: isEligible, rafflesDoneTonight: rafflesDone });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/my-wins?wallet=0x...
router.get('/my-wins', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try { res.json(getMyWins(wallet)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/my-history?wallet=0x... — todos los sorteos en que participé
// Incluye los resultados de La Chave Semanal (ganados, entregados y perdidos)
router.get('/my-history', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    // Auto-rechazar sorteos expirados antes de retornar el historial
    const { db, rejectRaffle } = require('../db/database');
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const expired = db.prepare(`
      SELECT id, prize FROM raffles
      WHERE status = 'pending_acceptance' AND acceptance_deadline <= ?
    `).all(nowStr);

    expired.forEach(r => {
      rejectRaffle(r.id, 'Tiempo de aceptación agotado');
      broadcast('raffle_timeout', { raffleId: r.id, prize: r.prize });
    });

    const history = getRaffleParticipation(wallet);

    // Chave Semanal: resultados resueltos en los que participé o gané.
    // Los pendientes de confirmar NO se incluyen — esa fase vive en la tarjeta semanal.
    const lowerWallet = wallet.toLowerCase();
    const weeklyRows = db.prepare(`
      SELECT w.* FROM weekly_raffles w
      WHERE w.status IN ('completed', 'forfeited') AND w.drawn_at IS NOT NULL
        AND (
          LOWER(COALESCE(w.winner_wallet, '')) = ?
          OR EXISTS (SELECT 1 FROM weekly_claims c WHERE c.claimed_week = w.claimed_week AND LOWER(c.wallet_address) = ?)
        )
      ORDER BY w.drawn_at DESC LIMIT 15
    `).all(lowerWallet, lowerWallet);

    const weeklyMapped = weeklyRows
      .filter(w => {
        let isWinner = false;
        if (w.winner_wallet) {
          try {
            const wallets = JSON.parse(w.winner_wallet);
            if (Array.isArray(wallets)) {
              isWinner = wallets.some(x => x.toLowerCase() === lowerWallet);
            } else {
              isWinner = wallets.toLowerCase() === lowerWallet;
            }
          } catch(e) {
            isWinner = w.winner_wallet.toLowerCase() === lowerWallet;
          }
        }
        // Ganador aún en plazo de confirmación (por-ganador) → fuera del historial (lo gestiona la tarjeta)
        const st = require('../db/database').weeklyWinnerState(w, lowerWallet);
        if (isWinner && w.status === 'completed' && !st.confirmedAt && !st.collectedAt && !st.forfeitedAt && w.confirm_deadline) {
          return new Date(w.confirm_deadline.replace(' ', 'T') + 'Z').getTime() <= Date.now();
        }
        return true;
      })
      .map(w => {
        let isWinner = false;
        let userCode = null; // código individual de ESTE ganador (no el JSON con todos)
        if (w.winner_wallet) {
          try {
            const wallets = JSON.parse(w.winner_wallet);
            const list = Array.isArray(wallets) ? wallets : [wallets];
            const matchWallet = list.find(x => x.toLowerCase() === lowerWallet);
            if (matchWallet) {
              isWinner = true;
              try {
                const codes = JSON.parse(w.verification_code || '{}');
                userCode = (codes && typeof codes === 'object' && !Array.isArray(codes))
                  ? codes[matchWallet]
                  : w.verification_code; // formato antiguo: string simple
              } catch(_) {
                userCode = w.verification_code; // formato antiguo: string simple
              }
            }
          } catch(e) {
            isWinner = w.winner_wallet.toLowerCase() === lowerWallet;
            userCode = w.verification_code;
          }
        }
        const st = require('../db/database').weeklyWinnerState(w, lowerWallet);
        let status;
        if (isWinner) {
          if (st.collectedAt) status = 'collected';
          else if (st.forfeitedAt) status = 'rejected';
          else status = 'accepted';
        } else {
          status = 'rejected';
        }
        const codeUnlocked = !!(st.confirmedAt || st.collectedAt || !w.confirm_deadline);
        // Premio NFT de la Chave Semanal: sin código canjeable; el ganador va al
        // furancho y el camarero se lo entrega. nft_granted = ya se lo dieron.
        const isNftPrize = !!w.nft_achievement_id;
        let nftGranted = false;
        if (isNftPrize) {
          try {
            const g = JSON.parse(w.nft_granted_wallets || '{}');
            nftGranted = Object.keys(g).some(k => k.toLowerCase() === lowerWallet);
          } catch (_) {}
        }
        return {
          id: 'weekly-' + w.claimed_week,
          is_weekly: 1,
          weekly_week: w.claimed_week, // para construir la URL del bono PDF
          prize: `🔑 Chave Semanal · ${w.prize}`,
          status,
          created_at: w.drawn_at,
          collected: st.collectedAt ? 1 : 0,
          collected_at: st.collectedAt,
          rejection_note: null,
          acceptance_deadline: null,
          is_winner: isWinner ? 1 : 0,
          // Si el premio es NFT no hay código: el flujo es presencial vía escáner.
          verification_code: (!isNftPrize && isWinner && codeUnlocked) ? userCode : null,
          prize_details: null,
          prize_image: null,
          establishment: null,
          nft_achievement_id: isNftPrize ? w.nft_achievement_id : null,
          nft_granted_at: nftGranted ? 'granted' : null
        };
      });

    const merged = [...history, ...weeklyMapped]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/raffle/:id/collect — admin confirma que el premio fue entregado
router.patch('/:id/collect', requireAuth, (req, res) => {
  const { note } = req.body;
  try {
    collectRaffle(parseInt(req.params.id), note || null);
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT winner_wallet FROM raffles WHERE id = ?`).get(parseInt(req.params.id));
    if (raffle?.winner_wallet) {
      const clientSSE = clients.find(c => c.walletAddress === raffle.winner_wallet);
      if (clientSSE) {
        try {
          clientSSE.res.write(`event: prize_collected\ndata: ${JSON.stringify({ raffleId: req.params.id })}\n\n`);
          if (typeof clientSSE.res.flush === 'function') clientSSE.res.flush();
        } catch (_) {}
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/raffle/:id/fix — admin corrige datos de un sorteo ya lanzado
// (validity_end_date, etc.) sin tocar la lógica del premio ni el ganador.
router.patch('/:id/fix', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const id = parseInt(req.params.id);
    const raffle = db.prepare(`SELECT id FROM raffles WHERE id = ?`).get(id);
    if (!raffle) return res.status(404).json({ error: 'Sorteo no encontrado' });
    const { validityEndDate } = req.body;
    if (validityEndDate !== undefined) {
      db.prepare(`UPDATE raffles SET validity_end_date = ? WHERE id = ?`).run(validityEndDate || null, id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/raffle/:id/redeem — CANJE en el local. Lo pulsa el staff en el móvil
// del ganador. No requiere admin: verifica que la wallet sea la del ganador.
// Idempotente: si ya estaba canjeado devuelve el estado sin re-marcar (evita doble canje).
router.post('/:id/redeem', (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Falta la wallet' });
  try {
    const result = redeemRaffleByWinner(parseInt(req.params.id), wallet);
    // Avisar por SSE al propio cliente para que la tarjeta se actualice al instante
    const clientSSE = clients.find(c => c.walletAddress && c.walletAddress.toLowerCase() === wallet.toLowerCase());
    if (clientSSE) {
      try {
        clientSSE.res.write(`event: prize_collected\ndata: ${JSON.stringify({ raffleId: req.params.id })}\n\n`);
        if (typeof clientSSE.res.flush === 'function') clientSSE.res.flush();
      } catch (_) {}
    }
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/raffle/history — historial completo (admin)
router.get('/history', requireAuth, (req, res) => {
  try { res.json(getRaffleHistory()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/eligible
router.get('/eligible', requireAuth, (req, res) => {
  const sessions = getEligibleRaffleParticipants(); // = elegibles (ficharon entrada hoy, no han salido)
  const eligibleSet = new Set(sessions);
  const withApp = clients.filter(c => c.walletAddress && eligibleSet.has(c.walletAddress)).length;
  const tonight = getRaffleCountTonight();
  // count = todos los que ficharon (participan aunque no tengan app abierta)
  res.json({ count: sessions.length, withApp, checkedIn: sessions.length, tonight });
});

// GET /api/raffle/active?wallet=0x... — estado del sorteo en curso (para clientes que cargan la app tarde)
router.get('/active', (req, res) => {
  const { wallet } = req.query;
  if (!activeRaffle || !wallet) return res.json({ active: false });
  if (!activeRaffle.eligibleWallets.has(wallet)) return res.json({ active: false });
  if (activeRaffle.phase === 'result') {
    const elapsed = Math.floor((Date.now() - activeRaffle.resultAt) / 1000);
    const remaining = activeRaffle.acceptWindow - elapsed;
    if (remaining <= 0) return res.json({ active: false });
    return res.json({ active: true, phase: 'result',
      winnerWallet: activeRaffle.winnerWallet, verificationCode: activeRaffle.verificationCode,
      prize: activeRaffle.prize, raffleId: activeRaffle.raffleId, acceptWindow: remaining,
      type: activeRaffle.type, prizeDetails: activeRaffle.prizeDetails,
      prizeImage: activeRaffle.prizeImage, establishment: activeRaffle.establishment,
      validity: activeRaffle.validity || null, people: activeRaffle.people || null, hours: activeRaffle.hours || null, days: activeRaffle.days || null });
  }
  return res.json({ active: true, phase: 'start', prize: activeRaffle.displayPrize,
    raffleId: activeRaffle.raffleId, type: activeRaffle.type,
    validity: activeRaffle.validity || null, people: activeRaffle.people || null, hours: activeRaffle.hours || null, days: activeRaffle.days || null });
});

// GET /api/raffle/prizes — lista de premios preset
router.get('/prizes', requireAuth, (req, res) => {
  try { res.json(getPrizePresets()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/raffle/prizes — añadir preset
router.post('/prizes', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Falta el nombre del premio' });
  try {
    const id = addPrizePreset(name.trim());
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/raffle/prizes/:id — eliminar preset
router.delete('/prizes/:id', requireAuth, (req, res) => {
  try {
    deletePrizePreset(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLANTILLAS CHAVE SEMANAL ────────────────────────────────────────────────

router.get('/weekly/templates', requireAuth, (req, res) => {
  try { res.json(getWeeklyPrizeTemplates()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/weekly/templates', requireAuth, (req, res) => {
  const { emoji, label, prize, rules } = req.body;
  if (!label?.trim() || !prize?.trim() || !rules?.trim()) return res.status(400).json({ error: 'Faltan campos (label, prize, rules)' });
  try {
    const id = addWeeklyPrizeTemplate({ emoji: emoji || '🎁', label: label.trim(), prize: prize.trim(), rules: rules.trim() });
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/weekly/templates/:id', requireAuth, (req, res) => {
  const { emoji, label, prize, rules } = req.body;
  try {
    updateWeeklyPrizeTemplate(parseInt(req.params.id), { emoji, label, prize, rules });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/weekly/templates/:id', requireAuth, (req, res) => {
  try {
    deleteWeeklyPrizeTemplate(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AGENDA DE SORTEOS ────────────────────────────────────────────────────────

// GET /api/raffle/scheduled?date=YYYY-MM-DD — público, sorteos programados para una fecha
router.get('/scheduled', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { wallet } = req.query;
    
    // Comprobar si el usuario ha fichado la entrada hoy y está en el local
    const eligibleSet = new Set(getEligibleRaffleParticipants().map(w => w.toLowerCase()));
    const isEligible = wallet && eligibleSet.has(wallet.toLowerCase());

    const raffles = getScheduledRaffles(date);
    const elig = require('../services/eligibility');
    const { db } = require('../db/database');

    // Ubicación del local: si el nombre coincide con un local VISIBLE de Ruta
    // Furancheira, adjuntamos su enlace de mapa para que el cliente pueda llegar.
    const partners = db.prepare(`SELECT name, maps_url FROM partner_establishments WHERE visible = 1`).all();
    const mapsByName = new Map(partners.map(p => [p.name.toLowerCase().trim(), p.maps_url]));
    const mapsFor = (name) => (name ? (mapsByName.get(name.toLowerCase().trim()) || null) : null);

    // Enmascarar premios si no está fichado hoy o si hide_name es true y no se ha lanzado.
    // Además adjuntar el requisito de elegibilidad (nivel/logro) y si ESTA wallet lo cumple,
    // para que pueda "ver el sorteo pero no entrar" con un motivo.
    const processed = raffles.map(r => {
      const criteria = { minLevel: r.participant_level, requiredAchievement: r.required_achievement };
      const e = wallet ? elig.checkEligibility(wallet, criteria) : { eligible: null, reason: null };
      // Para un premio YA sorteado: ¿le tocó a ESTA wallet? (para marcarlo en la propia lista)
      let you_won = null;
      if (wallet && r.status === 'launched' && r.raffle_id) {
        try {
          const w = db.prepare(`SELECT winner_wallet FROM raffles WHERE id = ?`).get(r.raffle_id);
          if (w && w.winner_wallet) you_won = w.winner_wallet.toLowerCase() === wallet.toLowerCase();
        } catch (_) {}
      }
      const meta = {
        requirement_label: elig.requirementLabel(criteria),
        eligible: wallet ? e.eligible : null,
        eligibility_reason: e.reason,
        you_won
      };
      const isPending = r.status === 'pending';
      const shouldHide = !isEligible || (r.hide_name && isPending);
      if (isPending && shouldHide) {
        const est = r.establishment && !isEligible ? null : r.establishment;
        return {
          ...r, ...meta,
          prize: 'Sorpresa 🎁',
          prize_details: null,
          prize_image: null,
          establishment: est,
          maps_url: mapsFor(est),
          validity: null,
          people: null,
          hours: null,
          days: null
        };
      }
      return { ...r, ...meta, maps_url: mapsFor(r.establishment) };
    });

    res.json(processed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/scheduled/all — admin, todos los programados (futuros)
router.get('/scheduled/all', requireAuth, (req, res) => {
  try { res.json(getScheduledRaffles(null)); } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/raffle/scheduled — admin, crear sorteo programado
router.post('/scheduled', requireAuth, (req, res) => {
  const { eventDate, scheduledTime, prize, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment, requiredAchievement, validity, people, hours, days, validityEndDate, nftAchievementId } = req.body;
  if (!eventDate || !scheduledTime || !prize)
    return res.status(400).json({ error: 'Faltan campos: eventDate, scheduledTime, prize' });
  try {
    const id = createScheduledRaffle({
      eventDate, scheduledTime, prize,
      targetLevel: targetLevel ? parseInt(targetLevel) : null,
      participantLevel: participantLevel ? parseInt(participantLevel) : null,
      type: type || 'night',
      hideName: !!hideName,
      prizeDetails: prizeDetails || null,
      prizeImage: prizeImage || null,
      establishment: establishment || null,
      requiredAchievement: requiredAchievement || null,
      validity: validity || null,
      people: people || null,
      hours: hours || null,
      days: days || null,
      validityEndDate: validityEndDate || null,
      nftAchievementId: nftAchievementId || null
    });
    res.json({ success: true, id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/raffle/scheduled/:id — admin, editar
router.patch('/scheduled/:id', requireAuth, (req, res) => {
  const { eventDate, scheduledTime, prize, status, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment, requiredAchievement, validity, people, hours, days, validityEndDate, nftAchievementId } = req.body;
  try {
    updateScheduledRaffle(parseInt(req.params.id), {
      eventDate, scheduledTime, prize, status,
      targetLevel: targetLevel !== undefined ? (targetLevel ? parseInt(targetLevel) : null) : undefined,
      participantLevel: participantLevel !== undefined ? (participantLevel ? parseInt(participantLevel) : null) : undefined,
      type, hideName, prizeDetails, prizeImage, establishment, requiredAchievement,
      validity, people, hours, days, validityEndDate,
      nftAchievementId: nftAchievementId !== undefined ? (nftAchievementId || null) : undefined
    });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/raffle/scheduled/:id — admin, eliminar
router.delete('/scheduled/:id', requireAuth, (req, res) => {
  try {
    deleteScheduledRaffle(parseInt(req.params.id));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Genera el HTML del bono. Reutilizable para el bono real del ganador y para la
// VISTA PREVIA del admin (mismo diseño, con el código enmascarado y un aviso).
// o: { prize, prize_details, prize_image, establishment, type, people, validity,
//      days, hours, dateStr, codeHtml, previewBanner }
function renderVoucherHtml(o) {
  let prizeImgHtml = '';
  if (o.type === 'local' && o.prize_image) {
    prizeImgHtml = `
        <div style="display:flex; align-items:center; justify-content:center; gap:16px; margin:0 auto 16px;">
          <img src="/assets/logo.png" alt="Furancho Sessions" style="max-height:50px; object-fit:contain;"/>
          <span style="font-size:20px; color:#c4973a; font-weight:700; opacity:0.8;">×</span>
          <img src="${o.prize_image}" alt="Logo Local" style="max-height:50px; max-width:100px; object-fit:contain; border-radius:8px; border:1.5px solid #c4973a; background:#fff; padding:2px;"/>
        </div>
      `;
  } else {
    prizeImgHtml = o.prize_image
      ? `<div style="margin-bottom:12px;"><img src="${o.prize_image}" style="max-height:80px;max-width:160px;object-fit:contain;border-radius:10px;" alt="Logo" /></div>`
      : '';
  }

  const establishmentHtml = o.establishment
    ? `<p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#8B1918;margin:4px 0 0;">${o.establishment}</p>`
    : '';
  const detailsHtml = o.prize_details
    ? `<div style="margin:12px auto;max-width:340px;background:#f9f4ec;border:1px dashed rgba(139,25,24,0.25);border-radius:12px;padding:12px 16px;text-align:left;"><p style="font-size:12px;color:#7A6A5A;line-height:1.6;margin:0;">${o.prize_details}</p></div>`
    : '';

  let conditionsHtml = '';
  if (o.people || o.validity || o.days || o.hours) {
    conditionsHtml = `
        <div style="margin:16px auto; max-width:340px; background:#fcfaf7; border:1.5px solid rgba(139,25,24,0.15); border-radius:14px; padding:14px; text-align:left; font-size:12px;">
          <p style="font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1.5px; color:#8B1918; margin-bottom:10px; border-bottom:1px dashed rgba(139,25,24,0.15); padding-bottom:6px; text-align:center;">📋 CONDICIONES DE VALIDEZ</p>
          <div style="display:grid; grid-template-columns:1fr; gap:6px; color:#2A1509;">
            ${o.people ? `<div style="display:flex; justify-content:space-between;"><strong>👥 Personas:</strong> <span>${o.people}</span></div>` : ''}
            ${o.validity ? `<div style="display:flex; justify-content:space-between;"><strong>📅 Validez:</strong> <span style="color:#8B1918; font-weight:700;">${o.validity}</span></div>` : ''}
            ${o.days ? `<div style="display:flex; justify-content:space-between;"><strong>🗓️ Días válidos:</strong> <span>${o.days}</span></div>` : ''}
            ${o.hours ? `<div style="display:flex; justify-content:space-between;"><strong>🕒 Horario:</strong> <span>${o.hours}</span></div>` : ''}
          </div>
        </div>
      `;
  }

  const bannerHtml = o.previewBanner
    ? `<div style="background:#c4973a;color:#2A1509;text-align:center;padding:8px 12px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;">👁 ${o.previewBanner}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Bono Premio · Furancho Sessions</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#F2EDE3;font-family:"Outfit",sans-serif;color:#2A1509;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .voucher{background:#fff;border-radius:20px;max-width:400px;width:100%;box-shadow:0 8px 40px rgba(42,21,9,.12);overflow:hidden;border:1px solid rgba(139,25,24,.1)}
    .vh{background:linear-gradient(135deg,#8B1918,#6B1212);padding:24px 20px 20px;text-align:center}
    .vb{padding:24px 20px;text-align:center}
    .vf{background:rgba(42,21,9,.04);border-top:1px dashed rgba(42,21,9,.15);padding:16px 20px;text-align:center}
    .code-box{background:#8B1918;color:#fff;border-radius:14px;padding:18px 24px;margin:16px 0;display:inline-block}
    .code-text{font-family:monospace;font-size:36px;font-weight:900;letter-spacing:8px}
    @media print{body{background:#fff;padding:0}.voucher{box-shadow:none;border:1px solid #ccc}.pBtn{display:none!important}}
  </style>
</head>
<body>
  <div class="voucher">
    ${bannerHtml}
    <div class="vh">
      <img src="/assets/logo.png" alt="Furancho Sessions" style="height:48px;margin-bottom:8px;"/>
      <p style="color:rgba(255,255,255,.7);font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0;">Bono Premio · Furancho Sessions</p>
    </div>
    <div class="vb">
      ${prizeImgHtml}
      ${establishmentHtml}
      <h1 style="font-family:'Playfair Display',serif;font-size:26px;font-weight:900;color:#8B1918;margin:12px 0 6px;line-height:1.2;">${o.prize}</h1>
      ${detailsHtml}
      ${conditionsHtml}
      <p style="font-size:12px;color:#7A6A5A;margin-top:10px;">${o.dateStr}</p>
      ${o.codeHtml}
      <p style="font-size:12px;color:#7A6A5A;line-height:1.6;margin-top:4px;">Presenta este bono al staff del local colaborador.<br>El código garantiza la autenticidad del premio.</p>
    </div>
    <div class="vf">
      <img src="/assets/logo.png" alt="" style="height:28px;opacity:.4;margin-bottom:4px;"/><br>
      <p style="font-size:10px;color:#7A6A5A;margin:0;">Furancho Sessions · Premio oficial</p>
      <button class="pBtn" onclick="window.print()" style="margin-top:12px;padding:10px 28px;background:#8B1918;color:#fff;border:none;border-radius:50px;font-family:'Outfit',sans-serif;font-size:14px;font-weight:700;cursor:pointer;">🖨️ Imprimir / Guardar PDF</button>
    </div>
  </div>
</body>
</html>`;
}

// GET /api/raffle/voucher/:id?wallet=0x... — bono descargable del ganador (HTML imprimible)
router.get('/voucher/:id', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).send('Falta wallet');
  try {
    const raffle = getRaffleById(parseInt(req.params.id));
    if (!raffle) return res.status(404).send('Sorteo no encontrado');
    if (raffle.winner_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(403).send('Acceso denegado');
    if (!['accepted','collected'].includes(raffle.status)) return res.status(400).send('Premio no aceptado aún');

    const dateStr = 'Otorgado el ' + new Date((raffle.accepted_at || raffle.created_at).replace(' ', 'T') + 'Z')
      .toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' });

    const codeHtml = `
      <div class="code-box">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,.7);margin-bottom:4px;">Código de verificación</p>
        <p class="code-text">${raffle.verification_code}</p>
      </div>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderVoucherHtml({ ...raffle, dateStr, codeHtml }));
  } catch (e) { res.status(500).send('Error al generar bono'); }
});

// GET /api/raffle/scheduled/:id/voucher-preview — VISTA PREVIA del bono para el
// admin, ANTES de sortear y SIN código real. Sirve para revisar que todo está bien.
router.get('/scheduled/:id/voucher-preview', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const s = db.prepare(`SELECT * FROM scheduled_raffles WHERE id = ?`).get(parseInt(req.params.id));
    if (!s) return res.status(404).send('Sorteo no encontrado');

    const codeHtml = `
      <div class="code-box" style="background:#7A6A5A;">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,.7);margin-bottom:4px;">Código de verificación</p>
        <p class="code-text">••••</p>
      </div>
      <p style="font-size:11px;color:#8B1918;font-weight:700;line-height:1.5;margin-top:2px;">🔒 El código real solo lo verá el ganador tras el sorteo.</p>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderVoucherHtml({ ...s, dateStr: 'Vista previa · aún sin sortear', codeHtml, previewBanner: 'Vista previa (admin) — no válido como bono' }));
  } catch (e) { res.status(500).send('Error al generar la vista previa'); }
});

module.exports = router;
module.exports.broadcast = broadcast;
module.exports.broadcastToAdmins = broadcastToAdmins;
module.exports.doLaunch = doLaunch;

// --- LÓGICA DE SORTEO SEMANAL ("LA CHAVE SEMANAL") ---

// GET /api/raffle/weekly/status?wallet=0x...&week=2026-W23
router.get('/weekly/status', (req, res) => {
  const { wallet, week } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta walletAddress' });
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const status = getWeeklyRaffleStatus(wallet, weekStr);
    const elig = require('../services/eligibility');
    const criteria = { minLevel: status.minLevel, requiredAchievement: status.requiredAchievement };
    const e = elig.checkEligibility(wallet, criteria);
    res.json({ ...status, currentWeek: weekStr, eligible: e.eligible, eligibilityReason: e.reason, requirementLabel: elig.requirementLabel(criteria) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CHAT 1:1 CON EL GANADOR DE LA CHAVE SEMANAL ---
// Permite que el ganador escriba al staff (dudas, agradecimientos) y que el staff
// le responda. Hilo identificado por wallet+semana, solo accesible para el ganador real.

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados mensajes. Espera un poco, ho.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isWeeklyRaffleWinnerWallet(winnerWalletRaw, wallet) {
  if (!winnerWalletRaw || !wallet) return false;
  let list;
  try {
    const parsed = JSON.parse(winnerWalletRaw);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    list = [winnerWalletRaw];
  }
  return list.some(w => String(w).toLowerCase() === wallet.toLowerCase());
}

// GET /api/raffle/weekly/chat?wallet=0x...&week=2026-W23 — hilo del cliente (público, solo el propio ganador)
router.get('/weekly/chat', (req, res) => {
  const { wallet, week } = req.query;
  if (!wallet || !week) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT winner_wallet FROM weekly_raffles WHERE claimed_week = ?`).get(week);
    if (!raffle || !isWeeklyRaffleWinnerWallet(raffle.winner_wallet, wallet)) {
      return res.status(403).json({ error: 'Esta wallet no es ganadora de esa semana' });
    }
    markWeeklyChatRead(wallet, week, 'client');
    res.json(getWeeklyChatMessages(wallet, week));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/raffle/weekly/chat — el ganador escribe al staff
router.post('/weekly/chat', chatLimiter, (req, res) => {
  const { wallet, week, message } = req.body;
  if (!wallet || !week || !message || !message.trim()) return res.status(400).json({ error: 'Faltan datos' });
  if (message.length > 500) return res.status(400).json({ error: 'Mensaje demasiado largo' });
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT winner_wallet FROM weekly_raffles WHERE claimed_week = ?`).get(week);
    if (!raffle || !isWeeklyRaffleWinnerWallet(raffle.winner_wallet, wallet)) {
      return res.status(403).json({ error: 'Esta wallet no es ganadora de esa semana' });
    }
    const body = message.trim();
    insertWeeklyChatMessage({ claimedWeek: week, walletAddress: wallet, sender: 'client', body });
    broadcastToAdmins('weekly_chat_message', { wallet, week, sender: 'client', body });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/raffle/admin/weekly-chats (ADMIN) — listado de hilos con no leídos
router.get('/admin/weekly-chats', requireAuth, (req, res) => {
  try {
    res.json(getWeeklyChatThreads());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/raffle/admin/weekly-chat?wallet=&week= (ADMIN) — hilo completo
router.get('/admin/weekly-chat', requireAuth, (req, res) => {
  const { wallet, week } = req.query;
  if (!wallet || !week) return res.status(400).json({ error: 'Faltan datos' });
  try {
    markWeeklyChatRead(wallet, week, 'admin');
    res.json(getWeeklyChatMessages(wallet, week));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/raffle/admin/weekly-chat (ADMIN) — el staff responde al ganador
router.post('/admin/weekly-chat', requireAuth, (req, res) => {
  const { wallet, week, message } = req.body;
  if (!wallet || !week || !message || !message.trim()) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const body = message.trim();
    insertWeeklyChatMessage({ claimedWeek: week, walletAddress: wallet, sender: 'admin', body });
    broadcast('weekly_chat_message', { wallet, week, sender: 'admin', body }, wallet);
    sendPushToWallet(wallet, '🔑 Mensaje del staff sobre tu premio', body, { url: '/claim' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Configuración de Rate Limiting para reclamos de Chave Semanal (Máximo 5 peticiones por minuto por IP para evitar spam)
const claimLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 5,
  message: { error: 'Demasiadas peticiones. Inténtalo de nuevo en un minuto, ho.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Ventana de participación de La Chave: domingo 21:00 → miércoles 21:00 (hora Madrid).
// Regla única en db/database.js (isWeeklyWindowOpen): la comparten claim, visibilidad
// del premio y cliente.
const isWeeklyClaimWindowOpen = isWeeklyWindowOpen;

// POST /api/raffle/weekly/claim
router.post('/weekly/claim', claimLimiter, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Falta walletAddress' });

  // Validar formato wallet — no se acepta week del cliente, siempre usamos la semana actual del servidor
  if (!/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida, ho.' });
  }
  if (!isWeeklyClaimWindowOpen()) {
    return res.status(400).json({ error: 'El boleto solo se puede trincar de domingo 21:00 a miércoles 21:00, ho. ¡Estate atento!' });
  }
  const weekStr = getWeeklyRaffleTargetWeek(); // <-- siempre server-side, ignoramos req.body.week
  try {
    const { db } = require('../db/database');
    const furancheiroRow = db.prepare(`
      SELECT 1 FROM mints WHERE LOWER(wallet_address) = LOWER(?)
      UNION
      SELECT 1 FROM sessions WHERE LOWER(wallet_address) = LOWER(?)
      LIMIT 1
    `).get(walletAddress.toLowerCase(), walletAddress.toLowerCase());

    if (!furancheiroRow) {
      return res.status(403).json({ error: 'Solo los furancheiros que hayan visitado el local o tengan un carnet VIP pueden participar en La Chave Semanal, ho.' });
    }

    // Bloquear si el sorteo de esta semana ya fue realizado
    const drawnRaffle = db.prepare(`SELECT status, min_level, required_achievement FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
    if (drawnRaffle && (drawnRaffle.status === 'completed' || drawnRaffle.status === 'forfeited')) {
      return res.status(400).json({ error: 'El sorteo de esta semana ya fue realizado, ho. ¡Apúntate a la próxima!' });
    }

    // Filtro de elegibilidad (nivel mínimo y/o logro). Verificación servidor.
    if (drawnRaffle && (drawnRaffle.min_level || drawnRaffle.required_achievement)) {
      const elig = require('../services/eligibility');
      const e = elig.checkEligibility(walletAddress, { minLevel: drawnRaffle.min_level, requiredAchievement: drawnRaffle.required_achievement });
      if (!e.eligible) return res.status(403).json({ error: `El sorteo de esta semana es ${e.reason}, ho.`, action: 'not_eligible' });
    }

    claimWeeklyRaffle(walletAddress, weekStr);
    res.json({ success: true, week: weekStr });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Ya has trincado tu participación para esta semana, ho.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/raffle/weekly/confirm — el ganador confirma el premio antes de las 23:00
router.post('/weekly/confirm', claimLimiter, (req, res) => {
  const { walletAddress, week } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida, ho.' });
  }
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const { confirmWeeklyRaffle, grantWeeklyNftPrize } = require('../db/database');
    const raffle = confirmWeeklyRaffle(walletAddress, weekStr);

    // Si el premio es un NFT, encolar el mint como pending_approval en cuanto
    // el ganador confirma. El admin lo aprueba cuando vea al cliente en el evento.
    if (raffle.nft_achievement_id) {
      try {
        grantWeeklyNftPrize(weekStr, walletAddress, 'auto_confirm');
      } catch (_) {}
    }

    // Devolver el código INDIVIDUAL de este ganador (no el JSON con todos).
    let userCode = raffle.verification_code;
    try {
      const codes = JSON.parse(raffle.verification_code || '{}');
      if (codes && typeof codes === 'object' && !Array.isArray(codes)) {
        const wallets = JSON.parse(raffle.winner_wallet);
        const list = Array.isArray(wallets) ? wallets : [wallets];
        const matched = list.find(w => w && w.toLowerCase() === walletAddress.toLowerCase());
        if (matched) userCode = codes[matched];
      }
    } catch (_) {}
    res.json({
      success: true,
      week: weekStr,
      prize: raffle.prize,
      verificationCode: userCode
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/weekly/status (ADMIN)
router.get('/admin/weekly/status', requireAuth, (req, res) => {
  const weekStr = req.query.week || getWeeklyRaffleTargetWeek();
  try {
    const { db, WEEKLY_DEFAULT_RULES } = require('../db/database');
    const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
    const totalParticipants = db.prepare(`SELECT COUNT(*) as count FROM weekly_claims WHERE claimed_week = ?`).get(weekStr)?.count || 0;
    const viewCount = getWeeklyMessageViewCount(weekStr);
    res.json({
      week: weekStr,
      viewCount,
      prize: raffle ? raffle.prize : null,
      prizeDetails: raffle ? (raffle.prize_details || null) : null,
      minLevel: raffle ? (raffle.min_level || null) : null,
      requiredAchievement: raffle ? (raffle.required_achievement || null) : null,
      rules: raffle ? (raffle.rules || WEEKLY_DEFAULT_RULES) : WEEKLY_DEFAULT_RULES,
      status: raffle ? raffle.status : 'active',
      winnerWallet: raffle ? raffle.winner_wallet : null,
      verificationCode: raffle ? raffle.verification_code : null,
      collectedAt: raffle ? raffle.collected_at : null,
      collectedWallets: raffle ? raffle.collected_wallets : null,
      forfeitedAt: raffle ? raffle.forfeited_at : null,
      forfeitedWallets: raffle ? raffle.forfeited_wallets : null,
      drawnAt: raffle ? raffle.drawn_at : null,
      confirmDeadline: raffle ? raffle.confirm_deadline : null,
      confirmedAt: raffle ? raffle.confirmed_at : null,
      confirmedWallets: raffle ? raffle.confirmed_wallets : null,
      totalParticipants,
      isConfigured: !!raffle,
      winnersCount: raffle ? (raffle.winners_count || 1) : 1,
      nftAchievementId: raffle ? (raffle.nft_achievement_id || null) : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/weekly/target-week (ADMIN)
router.get('/admin/weekly/target-week', requireAuth, (req, res) => {
  res.json({ week: getWeeklyRaffleTargetWeek() });
});

// GET /api/admin/weekly/all-weeks (ADMIN)
router.get('/admin/weekly/all-weeks', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const rows = db.prepare(`SELECT claimed_week FROM weekly_raffles ORDER BY claimed_week DESC`).all();
    res.json(rows.map(r => r.claimed_week));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/weekly/collect (ADMIN) — marcar premio como entregado
router.post('/admin/weekly/collect', requireAuth, (req, res) => {
  const { week } = req.body;
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    collectWeeklyRaffle(weekStr);
    // Notificar al ganador que su premio fue marcado como entregado (si sigue conectado)
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT winner_wallet, prize FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
    if (raffle?.winner_wallet) {
      broadcast('weekly_prize_collected', {
        prize: raffle.prize,
        week: weekStr
      }, raffle.winner_wallet);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/admin/weekly/collect-winner (ADMIN) — marcar el premio de UN ganador específico como entregado
router.post('/admin/weekly/collect-winner', requireAuth, (req, res) => {
  const { week, wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const result = collectWeeklyWinner(weekStr, wallet);
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT prize, winner_wallet FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
    if (raffle?.prize) {
      broadcast('weekly_prize_collected', { prize: raffle.prize, week: weekStr }, wallet);
    }
    res.json({ success: true, allCollected: result.allCollected });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/admin/weekly/forfeit (ADMIN) — dar premio por perdido (no recogido a tiempo)
router.post('/admin/weekly/forfeit', requireAuth, (req, res) => {
  const { week } = req.body;
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    forfeitWeeklyRaffle(weekStr);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/admin/weekly/config (ADMIN)
router.post('/admin/weekly/config', requireAuth, (req, res) => {
  const { prize, rules, week, winnersCount, prizeDetails, minLevel, requiredAchievement, nftAchievementId } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const { WEEKLY_DEFAULT_RULES } = require('../db/database');
    const wCount = winnersCount ? parseInt(winnersCount) : 1;
    const mLevel = minLevel ? parseInt(minLevel) : null;
    updateWeeklyPrize(weekStr, prize, rules || WEEKLY_DEFAULT_RULES, wCount, prizeDetails || null, mLevel, requiredAchievement || null, nftAchievementId || null);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/weekly/draw (ADMIN)
router.post('/admin/weekly/draw', requireAuth, (req, res) => {
  const { week } = req.body;
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const result = drawWeeklyRaffle(weekStr);

    // Enviar Push a todos informando del ganador de la Chave Semanal
    const { sendPushToAll } = require('../services/push');
    sendPushToAll(
      `🔑 ¡Chave Semanal sorteada!`,
      `Ya hay ganador de ${result.prize}. Abre la app: si te tocó, tienes hasta las 23:00 de hoy para confirmar, ho.`,
      {
        url: '/claim',
        image: '/assets/logo.png',
        actions: [{ action: 'open', title: '¿Me tocó? 🔑' }],
      }
    );

    // SSE: Notificar en tiempo real al ganador específico (si está conectado).
    // El código NO se envía: se revela al confirmar el premio.
    broadcast('weekly_draw_result', {
      winnerWallet: result.winnerWallet,
      prize: result.prize,
      confirmDeadline: result.confirmDeadline,
      week: weekStr
    }, result.winnerWallet);

    // SSE: Notificar a todos los demás que el sorteo terminó (sin revelar wallet)
    broadcast('weekly_draw_closed', {
      prize: result.prize,
      week: weekStr
    });

    res.json({ success: true, winnerWallet: result.winnerWallet, prize: result.prize });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/weekly/list (ADMIN)
router.get('/admin/weekly/list', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const raffles = db.prepare(`SELECT * FROM weekly_raffles ORDER BY claimed_week DESC`).all();
    const viewCounts = getWeeklyMessageViewCounts();
    const list = raffles.map(r => {
      const count = db.prepare(`SELECT COUNT(*) as count FROM weekly_claims WHERE claimed_week = ?`).get(r.claimed_week)?.count || 0;
      return {
        id: r.id,
        week: r.claimed_week,
        prize: r.prize,
        rules: r.rules,
        winnerWallet: r.winner_wallet,
        drawnAt: r.drawn_at,
        status: r.status,
        verificationCode: r.verification_code,
        collectedAt: r.collected_at,
        forfeitedAt: r.forfeited_at,
        confirmDeadline: r.confirm_deadline,
        confirmedAt: r.confirmed_at,
        totalParticipants: count,
        viewCount: viewCounts[r.claimed_week] || 0,
        winnersCount: r.winners_count || 1
      };
    });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/weekly/:week (ADMIN)
router.delete('/admin/weekly/:week', requireAuth, (req, res) => {
  const { week } = req.params;
  if (!week) return res.status(400).json({ error: 'Falta la semana' });
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT status FROM weekly_raffles WHERE claimed_week = ?`).get(week);
    if (!raffle) {
      return res.status(404).json({ error: 'No existe ese sorteo semanal' });
    }
    if (raffle.status !== 'active') {
      return res.status(400).json({ error: 'Solo se pueden eliminar sorteos activos (no realizados)' });
    }
    // Borrar claims de esa semana
    db.prepare(`DELETE FROM weekly_claims WHERE claimed_week = ?`).run(week);
    // Borrar el sorteo semanal
    db.prepare(`DELETE FROM weekly_raffles WHERE claimed_week = ?`).run(week);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RECUPERACIÓN TRAS REINICIO ───────────────────────────────────────────────
// Si el servidor se reinicia con un sorteo en ventana de aceptación, se reconstruye
// el estado desde la BD para que el ganador no pierda el premio ni el modal se quede colgado.
// Los timers no hacen falta re-armarlos: el sweeper de 5s rechaza al vencer el deadline.
(function recoverPendingRaffles() {
  try {
    const { db } = require('../db/database');
    const pending = db.prepare(`
      SELECT * FROM raffles WHERE status = 'pending_acceptance' ORDER BY created_at DESC
    `).all();
    if (!pending.length) return;

    const now = Date.now();
    const alive = pending.find(r => {
      if (!r.acceptance_deadline) return false;
      return new Date(r.acceptance_deadline.replace(' ', 'T') + 'Z').getTime() > now;
    });
    if (!alive) return; // los expirados los limpia el sweeper

    const participants = db.prepare(`SELECT wallet_address FROM raffle_participants WHERE raffle_id = ?`)
      .all(alive.id).map(x => x.wallet_address);
    const deadlineMs = new Date(alive.acceptance_deadline.replace(' ', 'T') + 'Z').getTime();
    const remaining = Math.max(1, Math.floor((deadlineMs - now) / 1000));

    activeRaffle = {
      raffleId: alive.id,
      prize: alive.prize,
      displayPrize: alive.hide_name ? 'Sorpresa 🎁' : alive.prize,
      type: alive.type || 'night',
      phase: 'result',
      eligibleWallets: new Set(participants),
      prizeDetails: alive.prize_details || null,
      prizeImage: alive.prize_image || null,
      establishment: alive.establishment || null,
      winnerWallet: alive.winner_wallet,
      verificationCode: alive.verification_code,
      acceptWindow: remaining,
      resultAt: now,
      startedAt: now
    };
    console.log(`[Raffle] ♻️ Estado recuperado tras reinicio: sorteo #${alive.id} "${alive.prize}" con ${remaining}s de ventana restante`);
  } catch (e) {
    console.error('[Raffle] Error recuperando sorteos pendientes:', e.message);
  }
})();

// Comprobación periódica en segundo plano de sorteos expirados y push de rescate (cada 5 segundos)
const _notifiedRescueRaffleIds = new Set();
setInterval(() => {
  try {
    const { db, rejectRaffle } = require('../db/database');
    const { sendPushToWallet } = require('../services/push');
    const now = Date.now();
    const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    
    // 1. Sorteos expirados
    const expired = db.prepare(`
      SELECT id, prize, winner_wallet FROM raffles 
      WHERE status = 'pending_acceptance' AND acceptance_deadline <= ?
    `).all(nowStr);
    
    expired.forEach(r => {
      rejectRaffle(r.id, 'Tiempo de aceptación agotado');
      console.log(`[Raffle] Sorteo ${r.id} expirado automáticamente. Premio: ${r.prize}. Ganador: ${r.winner_wallet}`);
      broadcast('raffle_timeout', { raffleId: r.id, prize: r.prize });
      if (activeRaffle?.raffleId === r.id) activeRaffle = null;
    });

    // 2. Alerta de rescate "Malo Será" (falta < 5 minutos)
    const deadlineSoon = new Date(now + 300000).toISOString().replace('T', ' ').slice(0, 19);
    const soonToExpire = db.prepare(`
      SELECT id, prize, winner_wallet FROM raffles
      WHERE status = 'pending_acceptance' AND acceptance_deadline > ? AND acceptance_deadline <= ?
    `).all(nowStr, deadlineSoon);

    soonToExpire.forEach(r => {
      if (!_notifiedRescueRaffleIds.has(r.id)) {
        _notifiedRescueRaffleIds.add(r.id);
        if (r.winner_wallet) {
          sendPushToWallet(
            r.winner_wallet,
            '🚨 ¡Malo será!',
            `Te ha tocado el premio "${r.prize}" en el Furancho y quedan menos de 5 min para trincarlo. ¡Abre la app, ho! 🍷`,
            { url: '/claim' }
          );
          console.log(`[Raffle] Push de rescate enviado para sorteo #${r.id} al ganador ${r.winner_wallet.slice(0,6)}...`);
        }
      }
    });

    // 3. Sorteos semanales expirados — solo los ganadores (por-ganador) que no confirmaron
    const forfeitedWeekly = forfeitExpiredWeeklyRaffles();
    forfeitedWeekly.forEach(r => {
      (r.wallets || []).forEach(wallet => {
        if (!wallet) return;
        sendPushToWallet(
          wallet,
          '🍷 La Chave de Furancho',
          `El tiempo para confirmar tu Chave ha pasado... mala suerte para la próxima. ¡Suerte la semana que viene! 🎲`,
          { url: '/claim' }
        );
        console.log(`[WeeklyRaffle] Sorteo semanal ${r.claimed_week} caducado. Push enviado a ${wallet.slice(0,8)}...`);
      });
    });

  } catch (e) {
    console.error('Error en autocheck de expiración y rescate de sorteos:', e);
  }
}, 5000);

