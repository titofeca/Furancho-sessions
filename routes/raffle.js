const express = require('express');
const router = express.Router();
const { getEligibleRaffleParticipants, insertRaffle, collectRaffle, getRaffleHistory, getMyWins } = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll } = require('../services/push');

// Mantenemos las conexiones SSE de los clientes
let clients = [];

// Función para enviar eventos a todos los clientes conectados
function broadcast(event, data) {
  const dead = [];
  clients.forEach(client => {
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
  res.setHeader('X-Accel-Buffering', 'no'); // desactiva buffering en Nginx/Railway

  res.write('data: {"connected": true}\n\n');

  const clientId = Date.now() + Math.random();
  const walletAddress = req.query.wallet || null;
  const newClient = { id: clientId, res, walletAddress };
  clients.push(newClient);

  // Keepalive cada 20 segundos para evitar timeout del proxy de Railway
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

// POST /api/raffle/start
// Solo llamado por el admin para iniciar un sorteo
router.post('/start', requireAuth, (req, res) => {
  const { prize } = req.body;
  
  if (!prize) {
    return res.status(400).json({ error: 'Falta el nombre del premio' });
  }

  // Solo participan clientes que han fichado entrada y aún no han salido
  const connectedWallets = [...new Set(
    clients.filter(c => c.walletAddress).map(c => c.walletAddress)
  )];
  const sessionWallets = getEligibleRaffleParticipants(); // sesiones abiertas en DB
  // Intersección: tienen sesión abierta (ficharon entrada) Y tienen la app abierta
  // Si nadie tiene la app abierta, usar solo sesiones DB
  const eligibleWallets = connectedWallets.length > 0
    ? sessionWallets.filter(w => connectedWallets.includes(w))
    : sessionWallets;

  if (eligibleWallets.length === 0) {
    return res.status(400).json({ error: 'No hay clientes con entrada fichada en este momento. Deben escanear el QR de entrada para participar.' });
  }

  const winnerIndex = Math.floor(Math.random() * eligibleWallets.length);
  const winnerWallet = eligibleWallets[winnerIndex];
  
  // Generar código de verificación corto (ej. A8K9)
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let verificationCode = '';
  for (let i = 0; i < 4; i++) {
    verificationCode += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  // Guardar en DB
  insertRaffle(prize, winnerWallet, verificationCode);

  // Informar a todos los móviles que EMPIEZA el sorteo (Ruleta de 30 segundos)
  console.log(`[Raffle] Iniciando sorteo. Clientes SSE: ${clients.length}, con wallet: ${connectedWallets.length}, sesiones DB: ${sessionWallets.length}`);
  broadcast('raffle_start', { duration: 15, prize });

  sendPushToAll('🎰 ¡Sorteo en Furancho!', `Se está sorteando: ${prize} — ¡Abre la app ahora!`, { url: '/claim' });

  setTimeout(() => {
    broadcast('raffle_result', { winnerWallet, verificationCode, prize });
  }, 15000);

  return res.json({
    success: true,
    message: 'Sorteo iniciado',
    participants: eligibleWallets.length,
    connected: connectedWallets.length,
    verificationCode,
    winnerWallet,
    raffleId
  });
});

// GET /api/raffle/my-wins?wallet=0x...
router.get('/my-wins', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    res.json(getMyWins(wallet));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/raffle/:id/collect — admin confirma que el premio fue entregado
router.patch('/:id/collect', requireAuth, (req, res) => {
  const { note } = req.body;
  try {
    collectRaffle(parseInt(req.params.id), note || null);
    // Notificar al ganador via SSE si está conectado
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/raffle/history — historial completo de sorteos (admin)
router.get('/history', requireAuth, (req, res) => {
  try {
    res.json(getRaffleHistory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/raffle/eligible
router.get('/eligible', requireAuth, (req, res) => {
  const connected = [...new Set(clients.filter(c => c.walletAddress).map(c => c.walletAddress))];
  const sessions  = getEligibleRaffleParticipants();
  const eligible  = connected.length > 0
    ? sessions.filter(w => connected.includes(w))
    : sessions;
  res.json({ count: eligible.length, withApp: connected.length, checkedIn: sessions.length });
});

module.exports = router;
