require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const {
  getStats,
  getHolders,
  getMultiLevelHolders,
  getWalletsByLevel,
  insertMessage,
  getMessages,
  addReaction,
  getReactionsForMessages,
  ALLOWED_REACTIONS
} = require('../db/database');
const { DEMO_MODE } = require('../services/polygon');
const { sendPushToAll } = require('../services/push');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furancho2024';
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

// Genera un token firmado con HMAC: base64(payload).signature
function generateToken() {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Verifica firma y expiración
function verifyToken(token) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const { ts } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return Date.now() - ts < TOKEN_TTL_MS;
}

// Middleware de autenticación
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && verifyToken(token)) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ success: true, token: generateToken() });
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

// GET /api/admin/inbox?level=2 — mensajes con reacciones (público para clientes)
router.get('/inbox', (req, res) => {
  const level = req.query.level || '1';
  try {
    const { db } = require('../db/database');
    const messages = db.prepare(`
      SELECT id, subject, body, sent_at FROM messages
      WHERE level_filter = 'all' OR level_filter = ?
      ORDER BY sent_at DESC LIMIT 20
    `).all(level.toString());
    const ids = messages.map(m => m.id);
    const reactions = ids.length ? getReactionsForMessages(ids) : {};
    res.json(messages.map(m => ({ ...m, reactions: reactions[m.id] || {} })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/react — cliente reacciona a un mensaje (público)
router.post('/react', (req, res) => {
  const { messageId, emoji, walletAddress } = req.body;
  if (!messageId || !emoji) return res.status(400).json({ error: 'Faltan datos' });
  if (!ALLOWED_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Emoji no válido' });
  try {
    addReaction(parseInt(messageId), emoji, walletAddress || null);
    const { getReactions } = require('../db/database');
    res.json({ success: true, reactions: getReactions(parseInt(messageId)) });
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

  // Push a móviles con pantalla apagada
  sendPushToAll(`📢 ${subject}`, body, { url: '/claim' });

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

// GET /api/admin/reactions-summary?ids=1,2,3 — resumen reacciones para admin
router.get('/reactions-summary', requireAuth, (req, res) => {
  const raw = (req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (!raw.length) return res.json({});
  try {
    res.json(getReactionsForMessages(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/peak-hours — datos de horas pico para gráfica
router.get('/peak-hours', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');

    // Presencia por hora: cuenta cuántas sesiones estaban activas en cada franja horaria
    // Una sesión cubre desde entry_time hasta exit_time (o ahora si está abierta)
    const hourCounts = db.prepare(`
      SELECT
        hour,
        COUNT(*) as sessions,
        COUNT(DISTINCT wallet_address) as unique_users
      FROM (
        SELECT
          wallet_address,
          CAST(strftime('%H', entry_time) AS INTEGER) as hour
        FROM sessions
        WHERE entry_time IS NOT NULL
        UNION ALL
        SELECT
          wallet_address,
          CAST(strftime('%H', exit_time) AS INTEGER) as hour
        FROM sessions
        WHERE exit_time IS NOT NULL
      )
      GROUP BY hour
      ORDER BY hour
    `).all();

    // Duración media por hora de entrada
    const avgByHour = db.prepare(`
      SELECT
        CAST(strftime('%H', entry_time) AS INTEGER) as hour,
        ROUND(AVG(duration_minutes), 0) as avg_min,
        COUNT(*) as count
      FROM sessions
      WHERE exit_time IS NOT NULL AND duration_minutes > 0 AND duration_minutes < 300
      GROUP BY hour
      ORDER BY hour
    `).all();

    // Día de la semana más activo
    const byWeekday = db.prepare(`
      SELECT
        CAST(strftime('%w', entry_time) AS INTEGER) as weekday,
        COUNT(*) as sessions,
        COUNT(DISTINCT wallet_address) as unique_users
      FROM sessions
      WHERE entry_time IS NOT NULL
      GROUP BY weekday
      ORDER BY weekday
    `).all();

    // Hora pico (la más concurrida)
    const peakHour = hourCounts.reduce((a, b) => b.unique_users > (a?.unique_users || 0) ? b : a, null);

    // Total sesiones históricas
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COUNT(DISTINCT wallet_address) as total_users,
        ROUND(AVG(CASE WHEN duration_minutes > 0 AND duration_minutes < 300 THEN duration_minutes END), 0) as avg_duration,
        COUNT(CASE WHEN exit_time IS NULL THEN 1 END) as open_now
      FROM sessions
    `).get();

    // Sesiones de los últimos 7 días por día
    const last7days = db.prepare(`
      SELECT
        date(entry_time) as day,
        COUNT(*) as sessions,
        COUNT(DISTINCT wallet_address) as unique_users
      FROM sessions
      WHERE entry_time >= datetime('now', '-7 days')
      GROUP BY day
      ORDER BY day
    `).all();

    res.json({ hourCounts, avgByHour, byWeekday, peakHour, totals, last7days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
