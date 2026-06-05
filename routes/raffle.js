const express = require('express');
const router = express.Router();
const {
  getEligibleRaffleParticipants, insertRaffle, acceptRaffle, rejectRaffle,
  collectRaffle, getRaffleHistory, getMyWins, getRaffleParticipation,
  getPrizePresets, addPrizePreset, deletePrizePreset, getRaffleCountTonight
} = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll } = require('../services/push');

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
  const { prize } = req.body;
  if (!prize) return res.status(400).json({ error: 'Falta el nombre del premio' });

  const connectedWallets = [...new Set(clients.filter(c => c.walletAddress).map(c => c.walletAddress))];
  const sessionWallets = getEligibleRaffleParticipants();
  const eligibleWallets = connectedWallets.length > 0
    ? sessionWallets.filter(w => connectedWallets.includes(w))
    : sessionWallets;

  if (eligibleWallets.length === 0) {
    return res.status(400).json({ error: 'No hay clientes con entrada fichada.' });
  }

  const winnerIndex = Math.floor(Math.random() * eligibleWallets.length);
  const winnerWallet = eligibleWallets[winnerIndex];

  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let verificationCode = '';
  for (let i = 0; i < 4; i++) verificationCode += characters.charAt(Math.floor(Math.random() * characters.length));

  const raffleId = insertRaffle(prize, winnerWallet, verificationCode, eligibleWallets);

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
    acceptRaffle(parseInt(req.params.id), wallet);
    // Notificar al admin via SSE broadcast
    broadcast('raffle_accepted', { raffleId: parseInt(req.params.id) });
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
  try { res.json(getRaffleParticipation(wallet)); } catch (e) { res.status(500).json({ error: e.message }); }
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

module.exports = router;
module.exports.broadcast = broadcast;
