const express = require('express');
const router = express.Router();
const { getEligibleRaffleParticipants, insertRaffle } = require('../db/database');
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

  // Usar clientes con app abierta (SSE) + sesiones abiertas como fallback
  const connectedWallets = [...new Set(
    clients.filter(c => c.walletAddress).map(c => c.walletAddress)
  )];
  const sessionWallets = getEligibleRaffleParticipants();
  const allWallets = [...new Set([...connectedWallets, ...sessionWallets])];
  const eligibleWallets = allWallets.length > 0 ? allWallets : connectedWallets;

  if (eligibleWallets.length === 0) {
    return res.status(400).json({ error: 'No hay clientes con la app abierta en este momento.' });
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
    winnerWallet
  });
});

// GET /api/raffle/eligible
router.get('/eligible', requireAuth, (req, res) => {
  const connected = [...new Set(clients.filter(c => c.walletAddress).map(c => c.walletAddress))];
  const sessions  = getEligibleRaffleParticipants();
  const all       = [...new Set([...connected, ...sessions])];
  res.json({ count: all.length, connected: connected.length, sessions: sessions.length });
});

module.exports = router;
