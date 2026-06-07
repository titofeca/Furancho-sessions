const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
  getEligibleRaffleParticipants, insertRaffle, acceptRaffle, rejectRaffle,
  collectRaffle, getRaffleHistory, getMyWins, getRaffleParticipation,
  getPrizePresets, addPrizePreset, deletePrizePreset, getRaffleCountTonight,
  getScheduledRaffles, createScheduledRaffle, updateScheduledRaffle,
  deleteScheduledRaffle, linkScheduledRaffle, insertMint,
  claimWeeklyRaffle, getWeeklyRaffleStatus, updateWeeklyPrize, drawWeeklyRaffle
} = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll } = require('../services/push');
const { notifyQueue } = require('../services/polygon');

let clients = [];

function broadcast(event, data, targetWallet = null) {
  const dead = [];
  const targets = targetWallet
    ? clients.filter(c => c.walletAddress === targetWallet)
    : clients;
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
  clients.push(newClient);

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

// POST /api/raffle/start — admin lanza sorteo
router.post('/start', requireAuth, (req, res) => {
  const { prize, scheduledId, targetLevel } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });

  // Si se pasa targetLevel, verificar que sea válido
  const sanitizedTargetLevel = targetLevel ? parseInt(targetLevel) : null;
  if (sanitizedTargetLevel && ![2, 3, 4].includes(sanitizedTargetLevel)) {
    return res.status(400).json({ error: 'Nivel de destino no válido. Debe ser 2, 3 o 4.' });
  }

  const connectedWallets = [...new Set(clients.filter(c => c.walletAddress).map(c => c.walletAddress))];
  const sessionWallets = getEligibleRaffleParticipants();
  const eligibleWallets = connectedWallets.length > 0
    ? sessionWallets.filter(w => connectedWallets.includes(w))
    : sessionWallets;

  if (eligibleWallets.length === 0) {
    return res.status(400).json({ error: 'No hay clientes con entrada fichada.' });
  }

  // Doble Oportunidad: si el ganador de "La Chave Semanal" de esta semana está en los elegibles, duplicarlo en el bombo.
  try {
    const { db } = require('../db/database');
    const weekStr = getYearWeek();
    const weeklyRaffle = db.prepare(`SELECT winner_wallet FROM weekly_raffles WHERE claimed_week = ? AND status = 'completed'`).get(weekStr);
    const weeklyWinner = weeklyRaffle ? weeklyRaffle.winner_wallet : null;

    if (weeklyWinner && eligibleWallets.includes(weeklyWinner)) {
      eligibleWallets.push(weeklyWinner);
      console.log(`[Raffle] Ganador de Chave Semanal (${weeklyWinner}) tiene DOBLE OPORTUNIDAD hoy. Duplicada en bombo.`);
    }
  } catch (e) {
    console.error('Error al aplicar doble oportunidad:', e.message);
  }

  const winnerIndex = Math.floor(Math.random() * eligibleWallets.length);
  const winnerWallet = eligibleWallets[winnerIndex];

  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let verificationCode = '';
  for (let i = 0; i < 4; i++) verificationCode += characters.charAt(Math.floor(Math.random() * characters.length));

  const raffleId = insertRaffle(prize, winnerWallet, verificationCode, eligibleWallets, sanitizedTargetLevel);
  if (scheduledId) { try { linkScheduledRaffle(parseInt(scheduledId), raffleId); } catch(_) {} }

  console.log(`[Raffle] #${raffleId} iniciado. Participantes: ${eligibleWallets.length}, SSE: ${connectedWallets.length}`);
  broadcast('raffle_start', { duration: 15, prize, raffleId });
  sendPushToAll('🎰 ¡Sorteo en Furancho!', `Se sortea: ${prize} — ¡Abre la app ahora!`, { url: '/claim' });

  // Revelar ganador tras 15s
  setTimeout(() => {
    broadcast('raffle_result', { winnerWallet, verificationCode, prize, raffleId, acceptWindow: 180 });
  }, 15000);

  // Auto-rechazar si no acepta en 180s + 15s de animación
  setTimeout(() => {
    try {
      const { db } = require('../db/database');
      const raffle = db.prepare(`SELECT status FROM raffles WHERE id = ?`).get(raffleId);
      if (raffle?.status === 'pending_acceptance') {
        rejectRaffle(raffleId, 'Tiempo de aceptación agotado');
        broadcast('raffle_timeout', { raffleId, prize });
        console.log(`[Raffle] #${raffleId} rechazado automáticamente — tiempo agotado`);
      }
    } catch (e) { console.error('[Raffle] Error en auto-rechazo:', e.message); }
  }, 195000);

  return res.json({ success: true, participants: eligibleWallets.length, raffleId, winnerWallet, verificationCode });
});

// POST /api/raffle/:id/accept — ganador acepta el premio (público, valida wallet)
router.post('/:id/accept', (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    const raffle = acceptRaffle(parseInt(req.params.id), wallet);
    // Notificar al admin via SSE broadcast
    broadcast('raffle_accepted', { raffleId: parseInt(req.params.id) });

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
    rejectRaffle(parseInt(req.params.id), note || 'Rechazado por admin');
    broadcast('raffle_rejected', { raffleId: parseInt(req.params.id) });
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
    const session = db.prepare(
      `SELECT id FROM sessions WHERE wallet_address = ? AND date(entry_time) = date('now') LIMIT 1`
    ).get(wallet);
    const rafflesDone = db.prepare(
      `SELECT COUNT(*) as count FROM raffles WHERE date(created_at) = date('now')`
    ).get()?.count || 0;
    res.json({ hasSessionToday: !!session, rafflesDoneTonight: rafflesDone });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/my-wins?wallet=0x...
router.get('/my-wins', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try { res.json(getMyWins(wallet)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raffle/my-history?wallet=0x... — todos los sorteos en que participé
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

    res.json(getRaffleParticipation(wallet));
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
  const connected = [...new Set(clients.filter(c => c.walletAddress).map(c => c.walletAddress))];
  const sessions = getEligibleRaffleParticipants();
  const eligible = connected.length > 0 ? sessions.filter(w => connected.includes(w)) : sessions;
  const tonight = getRaffleCountTonight();
  res.json({ count: eligible.length, withApp: connected.length, checkedIn: sessions.length, tonight });
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
  const { eventDate, scheduledTime, prize, targetLevel } = req.body;
  if (!eventDate || !scheduledTime || !prize)
    return res.status(400).json({ error: 'Faltan campos: eventDate, scheduledTime, prize' });
  try {
    const id = createScheduledRaffle({ eventDate, scheduledTime, prize, targetLevel: targetLevel ? parseInt(targetLevel) : null });
    res.json({ success: true, id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/raffle/scheduled/:id — admin, editar
router.patch('/scheduled/:id', requireAuth, (req, res) => {
  const { eventDate, scheduledTime, prize, status, targetLevel } = req.body;
  try {
    updateScheduledRaffle(parseInt(req.params.id), {
      eventDate,
      scheduledTime,
      prize,
      status,
      targetLevel: targetLevel !== undefined ? (targetLevel ? parseInt(targetLevel) : null) : undefined
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

module.exports = router;
module.exports.broadcast = broadcast;

// --- LÓGICA DE SORTEO SEMANAL ("LA CHAVE SEMANAL") ---

// Función para obtener la semana actual en formato YYYY-WW (siguiendo estándar ISO)
function getYearWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil(( ( (date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

// GET /api/raffle/weekly/status?wallet=0x...&week=2026-W23
router.get('/weekly/status', (req, res) => {
  const { wallet, week } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta walletAddress' });
  const weekStr = week || getYearWeek();
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

// POST /api/raffle/weekly/claim
router.post('/weekly/claim', claimLimiter, (req, res) => {
  const { walletAddress, week } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Falta walletAddress' });
  const weekStr = week || getYearWeek();
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

// GET /api/admin/weekly/status (ADMIN)
router.get('/admin/weekly/status', requireAuth, (req, res) => {
  const weekStr = req.query.week || getYearWeek();
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
    const totalParticipants = db.prepare(`SELECT COUNT(*) as count FROM weekly_claims WHERE claimed_week = ?`).get(weekStr)?.count || 0;
    res.json({
      week: weekStr,
      prize: raffle ? raffle.prize : 'Botella de Viño de la Casa',
      rules: raffle ? (raffle.rules || 'Trinca tu participación una vez por semana antes de que empiecen los eventos. ¡Se sorteará un regalo de la hostia!') : 'Trinca tu participación una vez por semana antes de que empiecen los eventos. ¡Se sorteará un regalo de la hostia!',
      status: raffle ? raffle.status : 'active',
      winnerWallet: raffle ? raffle.winner_wallet : null,
      drawnAt: raffle ? raffle.drawn_at : null,
      totalParticipants
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/weekly/config (ADMIN)
router.post('/admin/weekly/config', requireAuth, (req, res) => {
  const { prize, rules, week } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });
  const weekStr = week || getYearWeek();
  try {
    updateWeeklyPrize(weekStr, prize, rules || 'Trinca tu participación una vez por semana antes de que empiecen los eventos. ¡Se sorteará un regalo de la hostia!');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/weekly/draw (ADMIN)
router.post('/admin/weekly/draw', requireAuth, (req, res) => {
  const { week } = req.body;
  const weekStr = week || getYearWeek();
  try {
    const result = drawWeeklyRaffle(weekStr);

    // Enviar Push a todos informando del ganador de la Chave Semanal
    const { sendPushToAll } = require('../services/push');
    sendPushToAll(
      `🔑 ¡Sorteo Semanal Realizado!`,
      `El ganador de la Chave Semanal (${result.prize}) es la wallet ${result.winnerWallet.slice(0, 6)}...${result.winnerWallet.slice(-4)}. ¡Enhorabuena, ho!`,
      { url: '/claim' }
    );

    res.json({ success: true, winnerWallet: result.winnerWallet, prize: result.prize });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
