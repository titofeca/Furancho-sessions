const express = require('express');
const router = express.Router();
const { getEligibleRaffleParticipants, insertRaffle } = require('../db/database');
const { requireAuth } = require('./admin');
const { sendPushToAll } = require('../services/push');

// Mantenemos las conexiones SSE de los clientes
let clients = [];

// Función para enviar eventos a todos los clientes conectados
function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// GET /api/raffle/stream?wallet=0x...
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write('data: {"connected": true}\n\n');

  const clientId = Date.now() + Math.random();
  const walletAddress = req.query.wallet || null;
  const newClient = { id: clientId, res, walletAddress };
  clients.push(newClient);

  req.on('close', () => {
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
  broadcast('raffle_start', { duration: 30, prize });

  // Push a móviles con pantalla apagada
  sendPushToAll('🎰 ¡Sorteo en Furancho!', `Se está sorteando: ${prize} — ¡Abre la app ahora!`, { url: '/claim' });

  // Programar el anuncio del ganador para dentro de 30 segundos
  setTimeout(() => {
    broadcast('raffle_result', { winnerWallet, verificationCode, prize });
  }, 30000); // 30 segundos

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
// Para que el admin vea cuánta gente participa antes de lanzar
router.get('/eligible', requireAuth, (req, res) => {
  const eligibleWallets = getEligibleRaffleParticipants();
  res.json({ count: eligibleWallets.length });
});

module.exports = router;
