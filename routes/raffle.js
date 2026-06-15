const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  getEligibleRaffleParticipants, insertRaffle, acceptRaffle, rejectRaffle,
  collectRaffle, getRaffleHistory, getMyWins, getRaffleParticipation, getRaffleById,
  getPrizePresets, addPrizePreset, deletePrizePreset, getRaffleCountTonight,
  getScheduledRaffles, createScheduledRaffle, updateScheduledRaffle,
  deleteScheduledRaffle, linkScheduledRaffle, insertMint,
  claimWeeklyRaffle, getWeeklyRaffleStatus, updateWeeklyPrize, drawWeeklyRaffle, collectWeeklyRaffle, forfeitWeeklyRaffle,
  getWeeklyRaffleTargetWeek
} = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll } = require('../services/push');
const { notifyQueue } = require('../services/polygon');

// Configuración de upload de imágenes de premio
const uploadsDir = path.join(__dirname, '..', 'public', 'prize-images');
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
    if (/image\/(jpeg|jpg|png|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG/PNG'));
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

// GET /api/raffle/stream?wallet=0x...
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write('data: {"connected": true}\n\n');

  const clientId = Date.now() + Math.random();
  const walletAddress = req.query.wallet || null;
  const newClient = { id: clientId, res, walletAddress };

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
          duration: Math.max(1, 10 - elapsed), prize: activeRaffle.displayPrize, raffleId: activeRaffle.raffleId, type: activeRaffle.type
        })}\n\n`);
      } else if (activeRaffle.phase === 'result') {
        res.write(`event: raffle_result\ndata: ${JSON.stringify({
          winnerWallet: activeRaffle.winnerWallet, verificationCode: activeRaffle.verificationCode,
          prize: activeRaffle.prize, raffleId: activeRaffle.raffleId,
          acceptWindow: Math.max(0, activeRaffle.acceptWindow - Math.floor((Date.now() - activeRaffle.resultAt) / 1000)),
          type: activeRaffle.type, prizeDetails: activeRaffle.prizeDetails || null,
          prizeImage: activeRaffle.prizeImage || null, establishment: activeRaffle.establishment || null
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
function doLaunch({ prize, type = 'night', targetLevel = null, participantLevel = null, prizeDetails = null, prizeImage = null, establishment = null, hideName = false, scheduledId = null }) {
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

  const raffleId = insertRaffle(prize, winnerWallet, verificationCode, eligibleWallets, sanitizedTargetLevel, prizeDetails, prizeImage, establishment, type, hideName ? 1 : 0, sanitizedParticipantLevel);
  if (scheduledId) { try { linkScheduledRaffle(parseInt(scheduledId), raffleId); } catch(_) {} }

  const displayPrize = hideName ? 'Sorpresa 🎁' : prize;
  console.log(`[Raffle] #${raffleId} (${type}) iniciado. Participantes: ${eligibleWallets.length}, con app: ${connectedCount}`);

  // Guardar estado activo para que los clientes que abran la app tarde reciban el estado
  activeRaffle = {
    raffleId, prize, displayPrize, type, phase: 'start',
    eligibleWallets: eligibleSet,
    prizeDetails: prizeDetails || null, prizeImage: prizeImage || null, establishment: establishment || null,
    startedAt: Date.now()
  };

  // Solo enviar SSE a los elegibles (quienes ficharon entrada hoy)
  broadcastToEligible('raffle_start', { duration: 10, prize: displayPrize, raffleId, type }, eligibleSet);
  sendPushToAll('🎰 ¡Sorteo en Furancho!', `¡Abre la app ahora!`, { url: '/claim' });

  setTimeout(() => {
    const resultData = { winnerWallet, verificationCode, prize, raffleId, acceptWindow: 600, type,
      prizeDetails: prizeDetails || null, prizeImage: prizeImage || null, establishment: establishment || null };
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

  return { raffleId, winnerWallet, verificationCode, participants: eligibleWallets.length };
}

// POST /api/raffle/upload-image — sube imagen del premio (admin)
router.post('/upload-image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const url = `/prize-images/${req.file.filename}`;
  res.json({ success: true, url });
});

// POST /api/raffle/start — admin lanza sorteo manualmente con todos los datos
router.post('/start', requireAuth, (req, res) => {
  const { prize, scheduledId, targetLevel, participantLevel, prizeDetails, prizeImage, establishment, type, hideName } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });
  try {
    const result = doLaunch({ prize, type: type || 'night', targetLevel, participantLevel, prizeDetails, prizeImage, establishment, hideName: !!hideName, scheduledId });
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
      hideName: s.hide_name ? true : false, scheduledId: s.id
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
        // Ganador aún en plazo de confirmación → fuera del historial (lo gestiona la tarjeta)
        if (isWinner && w.status === 'completed' && !w.confirmed_at && !w.collected_at && w.confirm_deadline) {
          return new Date(w.confirm_deadline.replace(' ', 'T') + 'Z').getTime() <= Date.now();
        }
        return true;
      })
      .map(w => {
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
        let status;
        if (isWinner) {
          if (w.collected_at) status = 'collected';
          else if (w.status === 'forfeited') status = 'rejected';
          else status = 'accepted';
        } else {
          status = 'rejected';
        }
        const codeUnlocked = w.confirmed_at || w.collected_at || !w.confirm_deadline;
        return {
          id: 'weekly-' + w.claimed_week,
          is_weekly: 1,
          prize: `🔑 Chave Semanal · ${w.prize}`,
          status,
          created_at: w.drawn_at,
          collected: w.collected_at ? 1 : 0,
          collected_at: w.collected_at,
          rejection_note: null,
          acceptance_deadline: null,
          is_winner: isWinner ? 1 : 0,
          verification_code: isWinner && codeUnlocked ? w.verification_code : null,
          prize_details: null,
          prize_image: null,
          establishment: null
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
      prizeImage: activeRaffle.prizeImage, establishment: activeRaffle.establishment });
  }
  return res.json({ active: true, phase: 'start', prize: activeRaffle.displayPrize,
    raffleId: activeRaffle.raffleId, type: activeRaffle.type });
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

// ── AGENDA DE SORTEOS ────────────────────────────────────────────────────────

// GET /api/raffle/scheduled?date=YYYY-MM-DD — público, sorteos programados para una fecha
router.get('/scheduled', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    res.json(getScheduledRaffles(date));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/scheduled/all — admin, todos los programados (futuros)
router.get('/scheduled/all', requireAuth, (req, res) => {
  try { res.json(getScheduledRaffles(null)); } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/raffle/scheduled — admin, crear sorteo programado
router.post('/scheduled', requireAuth, (req, res) => {
  const { eventDate, scheduledTime, prize, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment } = req.body;
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
      establishment: establishment || null
    });
    res.json({ success: true, id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/raffle/scheduled/:id — admin, editar
router.patch('/scheduled/:id', requireAuth, (req, res) => {
  const { eventDate, scheduledTime, prize, status, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment } = req.body;
  try {
    updateScheduledRaffle(parseInt(req.params.id), {
      eventDate, scheduledTime, prize, status,
      targetLevel: targetLevel !== undefined ? (targetLevel ? parseInt(targetLevel) : null) : undefined,
      participantLevel: participantLevel !== undefined ? (participantLevel ? parseInt(participantLevel) : null) : undefined,
      type, hideName, prizeDetails, prizeImage, establishment
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

// GET /api/raffle/voucher/:id?wallet=0x... — bono descargable del ganador (HTML imprimible)
router.get('/voucher/:id', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).send('Falta wallet');
  try {
    const raffle = getRaffleById(parseInt(req.params.id));
    if (!raffle) return res.status(404).send('Sorteo no encontrado');
    if (raffle.winner_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(403).send('Acceso denegado');
    if (!['accepted','collected'].includes(raffle.status)) return res.status(400).send('Premio no aceptado aún');

    const prizeImgHtml = raffle.prize_image
      ? `<div style="margin-bottom:12px;"><img src="${raffle.prize_image}" style="max-height:80px;max-width:160px;object-fit:contain;border-radius:10px;" alt="Logo" /></div>`
      : '';
    const establishmentHtml = raffle.establishment
      ? `<p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#8B1918;margin:4px 0 0;">${raffle.establishment}</p>`
      : '';
    const detailsHtml = raffle.prize_details
      ? `<div style="margin:12px auto;max-width:340px;background:#f9f4ec;border:1px dashed rgba(139,25,24,0.25);border-radius:12px;padding:12px 16px;text-align:left;"><p style="font-size:12px;color:#7A6A5A;line-height:1.6;margin:0;">${raffle.prize_details}</p></div>`
      : '';
    const dateStr = new Date((raffle.accepted_at || raffle.created_at).replace(' ', 'T') + 'Z')
      .toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
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
    <div class="vh">
      <img src="/assets/logo.png" alt="Furancho Sessions" style="height:48px;margin-bottom:8px;"/>
      <p style="color:rgba(255,255,255,.7);font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0;">Bono Premio · Furancho Sessions</p>
    </div>
    <div class="vb">
      ${prizeImgHtml}
      ${establishmentHtml}
      <h1 style="font-family:'Playfair Display',serif;font-size:26px;font-weight:900;color:#8B1918;margin:12px 0 6px;line-height:1.2;">${raffle.prize}</h1>
      ${detailsHtml}
      <p style="font-size:12px;color:#7A6A5A;margin-top:10px;">Otorgado el ${dateStr}</p>
      <div class="code-box">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,.7);margin-bottom:4px;">Código de verificación</p>
        <p class="code-text">${raffle.verification_code}</p>
      </div>
      <p style="font-size:12px;color:#7A6A5A;line-height:1.6;margin-top:4px;">Presenta este bono al staff del local colaborador.<br>El código garantiza la autenticidad del premio.</p>
    </div>
    <div class="vf">
      <img src="/assets/logo.png" alt="" style="height:28px;opacity:.4;margin-bottom:4px;"/><br>
      <p style="font-size:10px;color:#7A6A5A;margin:0;">Furancho Sessions · Premio oficial</p>
      <button class="pBtn" onclick="window.print()" style="margin-top:12px;padding:10px 28px;background:#8B1918;color:#fff;border:none;border-radius:50px;font-family:'Outfit',sans-serif;font-size:14px;font-weight:700;cursor:pointer;">🖨️ Imprimir / Guardar PDF</button>
    </div>
  </div>
</body>
</html>`);
  } catch (e) { res.status(500).send('Error al generar bono'); }
});

module.exports = router;
module.exports.broadcast = broadcast;
module.exports.doLaunch = doLaunch;

// --- LÓGICA DE SORTEO SEMANAL ("LA CHAVE SEMANAL") ---

// GET /api/raffle/weekly/status?wallet=0x...&week=2026-W23
router.get('/weekly/status', (req, res) => {
  const { wallet, week } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta walletAddress' });
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const status = getWeeklyRaffleStatus(wallet, weekStr);
    res.json({ ...status, currentWeek: weekStr });
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
// Misma regla que muestra el cliente — validada también aquí para cerrar el hueco.
function isWeeklyClaimWindowOpen() {
  const madrid = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const day = madrid.getDay(); // 0=Dom..6=Sab
  const hours = madrid.getHours();
  if (day === 1 || day === 2) return true;
  if (day === 0) return hours >= 21;
  if (day === 3) return hours < 21;
  return false;
}

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
    const { confirmWeeklyRaffle } = require('../db/database');
    const raffle = confirmWeeklyRaffle(walletAddress, weekStr);
    res.json({
      success: true,
      week: weekStr,
      prize: raffle.prize,
      verificationCode: raffle.verification_code
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
    res.json({
      week: weekStr,
      prize: raffle ? raffle.prize : null,
      rules: raffle ? (raffle.rules || WEEKLY_DEFAULT_RULES) : WEEKLY_DEFAULT_RULES,
      status: raffle ? raffle.status : 'active',
      winnerWallet: raffle ? raffle.winner_wallet : null,
      verificationCode: raffle ? raffle.verification_code : null,
      collectedAt: raffle ? raffle.collected_at : null,
      forfeitedAt: raffle ? raffle.forfeited_at : null,
      drawnAt: raffle ? raffle.drawn_at : null,
      confirmDeadline: raffle ? raffle.confirm_deadline : null,
      confirmedAt: raffle ? raffle.confirmed_at : null,
      totalParticipants,
      isConfigured: !!raffle,
      winnersCount: raffle ? (raffle.winners_count || 1) : 1
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
  const { prize, rules, week, winnersCount } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });
  const weekStr = week || getWeeklyRaffleTargetWeek();
  try {
    const { WEEKLY_DEFAULT_RULES } = require('../db/database');
    const wCount = winnersCount ? parseInt(winnersCount) : 1;
    updateWeeklyPrize(weekStr, prize, rules || WEEKLY_DEFAULT_RULES, wCount);
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
      { url: '/claim' }
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
  } catch (e) {
    console.error('Error en autocheck de expiración y rescate de sorteos:', e);
  }
}, 5000);

