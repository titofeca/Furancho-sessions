require('dotenv').config();
const express = require('express');
const router = express.Router();
const {
  getStats,
  getHolders,
  getMultiLevelHolders,
  getWalletsByLevel,
  insertMessage,
  getMessages
} = require('../db/database');
const { DEMO_MODE } = require('../services/crossmint');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furancho2024';

// Middleware de autenticación simple
function requireAuth(req, res, next) {
  const authHeader = req.headers['x-admin-password'];
  if (authHeader !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD }); // simple token = password
  } else {
    res.status(401).json({ error: 'Contraseña incorrecta' });
  }
});

// GET /api/admin/current-message (PÚBLICO para clientes móviles)
// Devuelve el último mensaje publicado para un nivel o para todos
router.get('/current-message', (req, res) => {
  const level = req.query.level || 'all';
  try {
    const { db } = require('../db/database');
    const message = db.prepare(`
      SELECT * FROM messages 
      WHERE level_filter = 'all' OR level_filter = ? 
      ORDER BY sent_at DESC LIMIT 1
    `).get(level.toString());
    res.json(message || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/stats
router.get('/stats', requireAuth, (req, res) => {
  try {
    const stats = getStats();
    res.json({ ...stats, demoMode: DEMO_MODE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/holders?level=1
router.get('/holders', requireAuth, (req, res) => {
  try {
    const holders = getHolders(req.query.level);
    res.json(holders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/multilevel
router.get('/multilevel', requireAuth, (req, res) => {
  try {
    const holders = getMultiLevelHolders();
    res.json(holders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/send-message
// Body: { subject, body, levelFilter }
router.post('/send-message', requireAuth, async (req, res) => {
  const { subject, body, levelFilter } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Asunto y cuerpo son obligatorios' });
  }

  const wallets = getWalletsByLevel(levelFilter);

  // Guardar mensaje en DB
  const messageId = insertMessage({
    subject,
    body,
    levelFilter: levelFilter || 'all',
    recipientCount: wallets.length
  });

  console.log(`[MESSAGE] Mensaje publicado. Destinatarios estimados: ${wallets.length}`);
  
  return res.json({
    success: true,
    recipientCount: wallets.length,
    demo: false,
    message: `Mensaje publicado en las pantallas de los holders (${wallets.length} destinatarios)`
  });
});

// GET /api/admin/messages
router.get('/messages', requireAuth, (req, res) => {
  try {
    res.json(getMessages());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
