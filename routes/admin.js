require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
  getStats,
  getHolders,
  getMultiLevelHolders,
  getWalletsByLevel,
  getWalletsByAchievement,
  insertMessage,
  getMessages,
  addReaction,
  getReactionsForMessages,
  ALLOWED_REACTIONS,
  getEventSessions,
  getSessionDates,
  getPendingApprovalMints,
  approveMint,
  rejectMint,
  getVisitCount,
  getEligibleRaffleParticipants,
  getPartnerEstablishments,
  getVisiblePartnerEstablishments,
  upsertPartnerEstablishment,
  deletePartnerEstablishment
} = require('../db/database');
const multer = require('multer');
const { DEMO_MODE } = require('../services/polygon');
const { sendPushToAll, sendPushToWallet, sendPushToWallets } = require('../services/push');
const metrics = require('../services/metrics');
const { UPLOADS_DIR } = require('../db/database');
const cdUploadsDir = UPLOADS_DIR;
const cdStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, cdUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `countdown_${Date.now()}${ext}`);
  }
});
const cdUpload = multer({
  storage: cdStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|jpg|png)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo JPG o PNG'));
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furancho2024';
// ⚠️  IMPORTANTE: TOKEN_SECRET debe estar en Railway como variable de entorno.
//    Sin ella, cada deploy genera un secreto nuevo y los tokens guardados se invalidan.
//    Genera un valor fijo con: node -e "require('crypto').randomBytes(32).toString('hex')|>console.log"
// Resuelve el secreto de firma de tokens. Prioridad:
//   1) Variable de entorno TOKEN_SECRET (recomendado).
//   2) Secreto persistido en el volumen de datos (sobrevive reinicios/deploys sin tocar Railway).
//   3) Efímero en memoria (último recurso — invalidaría tokens al reiniciar).
function resolveTokenSecret() {
  if (process.env.TOKEN_SECRET) return process.env.TOKEN_SECRET;
  try {
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'furancho.db');
    const secretPath = path.join(path.dirname(DB_PATH), '.admin_token_secret');
    if (fs.existsSync(secretPath)) {
      const saved = fs.readFileSync(secretPath, 'utf8').trim();
      if (saved) return saved;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    console.warn('[Admin] TOKEN_SECRET no definido — generado y persistido en disco para sobrevivir reinicios.');
    return generated;
  } catch (e) {
    console.warn('[Admin] ⚠️  No se pudo persistir TOKEN_SECRET, usando efímero (se cerrará sesión al reiniciar):', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}
const TOKEN_SECRET = resolveTokenSecret();
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

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

// GET /api/admin/inbox?level=2&since=ISO_DATE — mensajes para clientes
// `since` = fecha de creación de cuenta del cliente; mensajes anteriores van marcados como archivados
router.get('/inbox', (req, res) => {
  const level = req.query.level || '1';
  const since = req.query.since || null; // ISO string, eg. "2026-06-05T18:00:00.000Z"
  const rawWallet = req.query.wallet || '';
  // Validar que la wallet tiene formato EVM antes de usarla en la query
  const ethRegex = /^0x[a-fA-F0-9]{40}$/;
  const wallet = ethRegex.test(rawWallet) ? rawWallet : '';
  try {
    const { db } = require('../db/database');
    // Solo incluir mensajes dirigidos a esta wallet si existe en nuestra BD (tiene al menos 1 visita)
    let verifiedWallet = '';
    if (wallet) {
      const known = db.prepare(`SELECT 1 FROM sessions WHERE wallet_address = ? LIMIT 1`).get(wallet);
      verifiedWallet = known ? wallet : '';
    }
    // ¿Está esta wallet fichada en local ahora mismo? → recibe también los mensajes 'checkedin'
    let isCheckedIn = false;
    if (verifiedWallet) {
      isCheckedIn = getEligibleRaffleParticipants()
        .some(w => w.toLowerCase() === verifiedWallet.toLowerCase());
    }
    // Logros NFT que tiene esta wallet (para mensajes con filtro de logro 'ach:<id>')
    const walletAchievements = new Set();
    if (verifiedWallet) {
      db.prepare(`SELECT achievement_id FROM achievement_mints WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'`)
        .all(verifiedWallet).forEach(r => walletAchievements.add(r.achievement_id));
    }
    const rawMessages = db.prepare(`
      SELECT id, subject, body, sent_at, rsvp_event_id, level_filter FROM messages
      WHERE level_filter = 'all' OR level_filter = ?
        OR (LOWER(level_filter) = LOWER(?) AND ? != '')
        OR (level_filter = 'checkedin' AND ?)
        OR (level_filter LIKE 'ach:%' AND ? != '')
      ORDER BY sent_at DESC LIMIT 50
    `).all(level.toString(), verifiedWallet, verifiedWallet, isCheckedIn ? 1 : 0, verifiedWallet);
    // Mensajes con filtro de logro: solo si la wallet tiene ese logro. Se quita level_filter del output.
    const messages = rawMessages
      .filter(m => !(m.level_filter && m.level_filter.startsWith('ach:')) || walletAchievements.has(m.level_filter.slice(4)))
      .slice(0, 30)
      .map(({ level_filter, ...rest }) => rest);
    const ids = messages.map(m => m.id);
    const reactions = ids.length ? getReactionsForMessages(ids) : {};
    res.json(messages.map(m => ({
      ...m,
      reactions: reactions[m.id] || {},
      archived: since ? m.sent_at < since : false
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/inbox/received — admin obtiene todos los DMs recibidos de clientes
router.get('/inbox/received', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const dms = db.prepare(`
      SELECT id, wallet_address, body, created_at
      FROM client_messages
      ORDER BY id DESC LIMIT 100
    `).all();
    res.json(dms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/inbox/reply — admin responde a un DM privado de cliente
router.post('/inbox/reply', requireAuth, (req, res) => {
  const { walletAddress, body } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
  }

  try {
    const { db } = require('../db/database');
    db.prepare(`
      INSERT INTO messages (subject, body, level_filter, recipient_count, action_type)
      VALUES (?, ?, ?, 1, 'reply')
    `).run('💬 Respuesta del Patrón', body.trim(), walletAddress.toLowerCase());
    
    res.json({ success: true });
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
    res.json({ ...stats, demoMode: DEMO_MODE, contractAddress: process.env.NFT_CONTRACT_ADDRESS || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/staff-code — código de acceso de camareros (para compartirlo con ellos)
router.get('/staff-code', requireAuth, (req, res) => {
  res.json({ code: process.env.STAFF_CODE || 'camareros', isDefault: !process.env.STAFF_CODE });
});

// GET /api/admin/achievement-stats — cuántas wallets tienen cada logro NFT especial
router.get('/achievement-stats', requireAuth, (req, res) => {
  try {
    res.json(require('../services/achievements').getAchievementStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/present-by-level — presentes AHORA en el local, por nivel y por logro
// (para el día del evento). Delega en services/metrics (fuente única de analítica).
router.get('/present-by-level', requireAuth, (req, res) => {
  try {
    const data = require('../services/metrics').getPresentByLevel();
    const cat = require('../services/achievements').getAchievementStats();
    const byAchievement = cat.map(a => ({ id: a.id, name: a.name, edition: a.edition, count: data.byAchievement[a.id] || 0 }));
    res.json({ total: data.total, byLevel: data.byLevel, byAchievement });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FACTURACIÓN POR EVENTO (PRIVADO — solo admin) ────────────────────────────
// Estos endpoints están bajo requireAuth y NO tienen equivalente público. El dato
// de facturación vive en la tabla event_finances (separada de `events`), así que
// no se filtra por /api/events ni por ningún endpoint de cliente.

// GET /api/admin/event-finances — resumen por evento + totales/medias para gráficos
router.get('/event-finances', requireAuth, (req, res) => {
  try {
    res.json(require('../db/database').getEventFinancesSummary());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/business-report?from=YYYY-MM-DD&to=YYYY-MM-DD — informe de negocio
// (afluencia + comunidad + facturación + adopción de la app) con comparativa del
// periodo anterior de igual longitud. Toda la lógica vive en services/metrics.js.
router.get('/business-report', requireAuth, (req, res) => {
  try {
    res.json(require('../services/metrics').getBusinessReport(req.query.from, req.query.to));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/event-finances/:eventId — facturación de un evento (para precargar el modal)
router.get('/event-finances/:eventId', requireAuth, (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: 'ID de evento no válido' });
  try {
    res.json(require('../db/database').getEventFinance(eventId) || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/event-finances/:eventId — guarda/actualiza la facturación de un evento.
// Body: { revenue (€), covers, tables, vipCount, notes }. Campos vacíos = "sin dato".
router.post('/event-finances/:eventId', requireAuth, (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: 'ID de evento no válido' });
  try {
    const { db, setEventFinance } = require('../db/database');
    const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

    const { revenue, covers, tables, vipCount, notes,
      costStaff, costDj, costBand, costFnb, costDecor, costOther, costOtherLabel } = req.body || {};
    // Validación: números no negativos o vacío. Los importes llegan en euros y se
    // guardan en céntimos (redondeo al céntimo) para no arrastrar decimales.
    const numOrNull = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!isFinite(n) || n < 0) throw new Error('Valor numérico no válido');
      return n;
    };
    const eurosToCents = (v) => { const n = numOrNull(v); return n != null ? Math.round(n * 100) : null; };
    const result = setEventFinance(eventId, {
      revenueCents: eurosToCents(revenue),
      covers: numOrNull(covers) != null ? Math.round(numOrNull(covers)) : null,
      tables: numOrNull(tables) != null ? Math.round(numOrNull(tables)) : null,
      vipCount: numOrNull(vipCount) != null ? Math.round(numOrNull(vipCount)) : null,
      notes: (typeof notes === 'string' && notes.trim()) ? notes.trim().slice(0, 500) : null,
      // Costes por categoría (personal, DJ, grupo, F&B, decoración, otros con nombre)
      costStaffCents: eurosToCents(costStaff),
      costDjCents: eurosToCents(costDj),
      costBandCents: eurosToCents(costBand),
      costFnbCents: eurosToCents(costFnb),
      costDecorCents: eurosToCents(costDecor),
      costOtherCents: eurosToCents(costOther),
      costOtherLabel: (typeof costOtherLabel === 'string' && costOtherLabel.trim()) ? costOtherLabel.trim().slice(0, 100) : null
    });
    res.json({ success: true, finance: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/admin/debug-push
router.get('/debug-push', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const fs = require('fs');
    const path = require('path');
    let codeSnippet = 'not found';
    try {
      const content = fs.readFileSync(__filename, 'utf8');
      const snippetIndex = content.indexOf('debug-push');
      if (snippetIndex !== -1) codeSnippet = content.substring(snippetIndex, snippetIndex + 300);
    } catch (_) {}

    const vapidPublic = process.env.VAPID_PUBLIC_KEY || null;
    const hasVapidPrivate = !!process.env.VAPID_PRIVATE_KEY;
    const subsCount = db.prepare("SELECT COUNT(*) as count FROM push_subscriptions").get()?.count || 0;
    const subs = db.prepare("SELECT wallet_address, substr(endpoint, 1, 40) as endpoint_short, created_at FROM push_subscriptions LIMIT 100").all();
    const raffles = db.prepare("SELECT * FROM weekly_raffles ORDER BY claimed_week DESC LIMIT 5").all();
    const scheduledRaffles = db.prepare("SELECT * FROM scheduled_raffles ORDER BY event_date DESC, scheduled_time DESC LIMIT 10").all();
    const generalRaffles = db.prepare("SELECT * FROM raffles ORDER BY created_at DESC LIMIT 10").all();
    
    let pushLogs = [];
    try {
      pushLogs = db.prepare("SELECT * FROM push_logs ORDER BY timestamp DESC LIMIT 50").all();
    } catch (_) {}

    res.json({
      codeSnippet,
      vapidPublic,
      hasVapidPrivate,
      subsCount,
      subs,
      raffles,
      scheduledRaffles,
      generalRaffles,
      pushLogs
    });
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
  const { subject, body, levelFilter, rsvpEventId, actionType } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Asunto y cuerpo son obligatorios' });
  }

  // Evento al que se adjunta el botón (opcional). null = mensaje normal sin botón.
  const rsvpEvent = rsvpEventId != null && rsvpEventId !== '' && !isNaN(parseInt(rsvpEventId))
    ? parseInt(rsvpEventId) : null;

  // 'checkedin' = solo clientes que ficharon entrada esta noche dentro de la ventana del evento.
  // 'ach:<id>' = solo clientes que tienen ese logro NFT.
  const checkedInOnly = levelFilter === 'checkedin';
  const isAchFilter = typeof levelFilter === 'string' && levelFilter.startsWith('ach:');
  const wallets = checkedInOnly
    ? getEligibleRaffleParticipants()
    : isAchFilter
      ? getWalletsByAchievement(levelFilter.slice(4))
      : getWalletsByLevel(levelFilter);

  // Guardar mensaje en DB
  const messageId = insertMessage({
    subject,
    body,
    levelFilter: levelFilter || 'all',
    recipientCount: wallets.length,
    rsvpEventId: rsvpEvent,
    actionType: actionType || null
  });

  console.log(`[MESSAGE] Mensaje publicado. Destinatarios estimados: ${wallets.length}${checkedInOnly ? ' (solo fichados en local)' : ''}`);

  // Push a móviles con pantalla apagada
  const pushData = { url: '/claim', image: '/assets/logo.png' };
  if (checkedInOnly || isAchFilter) {
    sendPushToWallets(wallets, `📢 ${subject}`, body, pushData);
  } else if (levelFilter && levelFilter.startsWith('0x')) {
    sendPushToWallet(levelFilter, `✉️ Mensaje privado: ${subject}`, body, pushData);
  } else {
    sendPushToAll(`📢 ${subject}`, body, pushData);
  }

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

// GET /api/admin/event-sessions?date=YYYY-MM-DD — visitas de un día (admin)
router.get('/event-sessions', requireAuth, (req, res) => {
  try {
    const sessions = getEventSessions(req.query.date || null);
    const dates = getSessionDates();
    res.json({ sessions, dates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/peak-hours?date=YYYY-MM-DD — estadísticas por fecha o totales
router.get('/peak-hours', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const date = req.query.date || null;

    // Filtro SQL: si hay fecha filtra ese día; para totales solo sesiones de días con evento
    // Validar formato YYYY-MM-DD para evitar inyeccion SQL
    const safeDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const dateWhere = safeDate
      ? `date(entry_time) = ?`
      : `date(entry_time) IN (SELECT event_date FROM events)
         AND NOT (date(entry_time) = '2026-06-04' AND time(entry_time) < '17:30:00')`;
    const dateParam = safeDate ? [safeDate] : [];

    // SQLite guarda UTC; España = CEST (UTC+2 en verano). Ajustamos +2h para mostrar hora local.
    const TZ_OFFSET = `'+2 hours'`;

    const hourCounts = safeDate
      ? db.prepare(`
          SELECT hour, COUNT(*) as sessions, COUNT(DISTINCT LOWER(wallet_address)) as unique_users
          FROM (
            SELECT LOWER(wallet_address) as wallet_address, CAST(strftime('%H', entry_time, ${TZ_OFFSET}) AS INTEGER) as hour
            FROM sessions WHERE entry_time IS NOT NULL AND date(entry_time) = ?
            UNION ALL
            SELECT LOWER(wallet_address) as wallet_address, CAST(strftime('%H', exit_time, ${TZ_OFFSET}) AS INTEGER) as hour
            FROM sessions WHERE exit_time IS NOT NULL AND date(exit_time) = ?
          ) GROUP BY hour ORDER BY hour
        `).all(safeDate, safeDate)
      : db.prepare(`
          SELECT hour, COUNT(*) as sessions, COUNT(DISTINCT LOWER(wallet_address)) as unique_users
          FROM (
            SELECT LOWER(wallet_address) as wallet_address, CAST(strftime('%H', entry_time, ${TZ_OFFSET}) AS INTEGER) as hour
            FROM sessions WHERE entry_time IS NOT NULL AND ${dateWhere}
            UNION ALL
            SELECT LOWER(wallet_address) as wallet_address, CAST(strftime('%H', exit_time, ${TZ_OFFSET}) AS INTEGER) as hour
            FROM sessions WHERE exit_time IS NOT NULL AND ${dateWhere}
          ) GROUP BY hour ORDER BY hour
        `).all();

    const avgByHour = db.prepare(`
      SELECT CAST(strftime('%H', entry_time, ${TZ_OFFSET}) AS INTEGER) as hour,
             ROUND(AVG(duration_minutes), 0) as avg_min, COUNT(*) as count
      FROM sessions
      WHERE exit_time IS NOT NULL AND duration_minutes > 0 AND duration_minutes < 300 AND ${dateWhere}
      GROUP BY hour ORDER BY hour
    `).all();

    const byWeekday = date ? [] : db.prepare(`
      SELECT CAST(strftime('%w', entry_time, ${TZ_OFFSET}) AS INTEGER) as weekday,
             COUNT(*) as sessions, COUNT(DISTINCT LOWER(wallet_address)) as unique_users
      FROM sessions WHERE entry_time IS NOT NULL AND ${dateWhere}
      GROUP BY weekday ORDER BY weekday
    `).all();

    const peakHour = hourCounts.reduce((a, b) => b.unique_users > (a?.unique_users || 0) ? b : a, null);

    const totals = db.prepare(`
      SELECT COUNT(*) as total_sessions,
             COUNT(DISTINCT LOWER(wallet_address)) as total_users,
             ROUND(AVG(CASE WHEN duration_minutes > 0 AND duration_minutes < 300 THEN duration_minutes END), 0) as avg_duration,
             COUNT(CASE WHEN exit_time IS NULL THEN 1 END) as open_now
      FROM sessions WHERE ${dateWhere}
    `).get();

    // Cabeceras canónicas (motor de métricas) — para que "Estadísticas globales"
    // coincida con el resto del panel: asistentes únicos, asistencias y estancia real.
    try {
      const canon = safeDate ? metrics.getEventDetail(safeDate) : metrics.getTotalsDetail();
      const vs = metrics.getVisitStats();
      totals.open_now = metrics.getActiveNow();
      totals.total_users = safeDate
        ? (metrics.getAttendanceByDate().find(e => e.event_date === safeDate)?.attendees ?? totals.total_users)
        : vs.uniqueVisitors;
      totals.total_sessions = safeDate
        ? (metrics.getAttendanceByDate().find(e => e.event_date === safeDate)?.attendees ?? totals.total_sessions)
        : vs.totalVisits;
      if (canon && canon.avg_duration != null) totals.avg_duration = canon.avg_duration;
    } catch (_) {}

    // Clientes habituales (3+ visitas)
    const regulars = db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT wallet_address FROM sessions
        WHERE counted_as_visit = 1 AND ${dateWhere.replace(/entry_time/g, 'entry_time')}
        GROUP BY LOWER(wallet_address) HAVING COUNT(*) >= 3
      )
    `).get();

    // Timeline por día para totales (o datos del día seleccionado por hora ya en hourCounts)
    const timeline = !date ? db.prepare(`
      SELECT date(entry_time) as day, COUNT(*) as sessions, COUNT(DISTINCT LOWER(wallet_address)) as unique_users
      FROM sessions WHERE entry_time IS NOT NULL AND ${dateWhere}
      GROUP BY day ORDER BY day DESC LIMIT 20
    `).all() : [];

    res.json({ hourCounts, avgByHour, byWeekday, peakHour, totals, regulars: regulars?.count || 0, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/funnel — Funnel de conversión por niveles
router.get('/funnel', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');

    const levelRows = db.prepare(`
      SELECT level, COUNT(*) as count FROM (
        SELECT LOWER(wallet_address) as wallet_address, MAX(level) as level
        FROM mints WHERE status != 'failed' GROUP BY LOWER(wallet_address)
        UNION ALL
        SELECT LOWER(wallet_address) as wallet_address, 1 as level
        FROM (
          SELECT wallet_address FROM sessions
          UNION
          SELECT wallet_address FROM visits
        )
        WHERE LOWER(wallet_address) NOT IN (SELECT LOWER(wallet_address) FROM mints WHERE status != 'failed')
        GROUP BY LOWER(wallet_address)
      ) GROUP BY level
    `).all();
    const levelMap = {};
    levelRows.forEach(r => { levelMap[r.level] = r.count; });
    const c1 = levelMap[1] || 0;
    const c2 = levelMap[2] || 0;
    const c3 = levelMap[3] || 0;
    const c4 = levelMap[4] || 0;

    const nv4 = c4;
    const nv3 = c3 + nv4;
    const nv2 = c2 + nv3;
    const nv1 = c1 + nv2;

    // pct_of_total = % sobre la base Nv1 (total de clientes únicos)
    // pct_prev     = % sobre el nivel inmediatamente anterior (para info adicional)
    const funnel = [
      { level: 1, name: 'Nv1 — Cautivo',        count: nv1, pct_prev: 100,                                                      pct_of_total: 100 },
      { level: 2, name: 'Nv2 — Cunqueiro',       count: nv2, pct_prev: nv1 > 0 ? Math.round(nv2 / nv1 * 100) : 0,              pct_of_total: nv1 > 0 ? Math.round(nv2 / nv1 * 100) : 0 },
      { level: 3, name: 'Nv3 — Larpeiro',        count: nv3, pct_prev: nv2 > 0 ? Math.round(nv3 / nv2 * 100) : 0,              pct_of_total: nv1 > 0 ? Math.round(nv3 / nv1 * 100) : 0 },
      { level: 4, name: 'Nv4 — Presidente',      count: nv4, pct_prev: nv3 > 0 ? Math.round(nv4 / nv3 * 100) : 0,              pct_of_total: nv1 > 0 ? Math.round(nv4 / nv1 * 100) : 0 }
    ];

    // Ganas (RSVP) vs aparición real — la aparición usa la MISMA definición de
    // asistencia que el resto del panel (motor de métricas), no un join suelto.
    const attendeesByDate = metrics.getAttendeeWalletsByDate();
    const noshow = db.prepare(`
      SELECT e.id, e.event_date, e.title,
        (SELECT COUNT(*) FROM rsvps WHERE event_id=e.id) as rsvp_count
      FROM events e WHERE e.active=1 ORDER BY e.event_date DESC LIMIT 6
    `).all().map(e => {
      const rsvpWallets = db.prepare(`SELECT LOWER(wallet_address) w FROM rsvps WHERE event_id=?`).all(e.id).map(r => r.w);
      const attended = new Set(attendeesByDate[e.event_date] || []);
      const actual_count = rsvpWallets.filter(w => attended.has(w)).length;
      return { event_date: e.event_date, title: e.title, rsvp_count: e.rsvp_count, actual_count };
    });

    // Nuevos por evento — definición canónica (primera asistencia del wallet = ese evento).
    const newByEvent = metrics.getNewByEvent().slice(0, 6);

    const gapRow = db.prepare(`
      WITH unique_visits AS (
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date
        FROM sessions WHERE counted_as_visit = 1
        UNION
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date
        FROM visits
      ),
      ranked_visits AS (
        SELECT wallet_address, visit_date,
               ROW_NUMBER() OVER (PARTITION BY wallet_address ORDER BY visit_date ASC) as rn
        FROM unique_visits
      ),
      gaps AS (
        SELECT wallet_address,
               CAST(julianday(MAX(CASE WHEN rn = 2 THEN visit_date END)) - julianday(MAX(CASE WHEN rn = 1 THEN visit_date END)) AS INTEGER) as gap
        FROM ranked_visits
        WHERE rn <= 2
        GROUP BY wallet_address
        HAVING COUNT(*) >= 2
      )
      SELECT AVG(gap) as avg_gap FROM gaps
    `).get();

    // Retorno real: de TODOS los clientes únicos, cuántos volvieron en <=30 días desde su 1ª visita
    const retornoRow = db.prepare(`
      WITH unique_visits AS (
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date
        FROM sessions WHERE counted_as_visit = 1
        UNION
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date
        FROM visits
      ),
      ranked_visits AS (
        SELECT wallet_address, visit_date,
               ROW_NUMBER() OVER (PARTITION BY wallet_address ORDER BY visit_date ASC) as rn
        FROM unique_visits
      ),
      all_wallets AS (
        SELECT DISTINCT wallet_address FROM unique_visits
      ),
      second_visits AS (
        SELECT wallet_address,
               CAST(julianday(MAX(CASE WHEN rn = 2 THEN visit_date END)) - julianday(MAX(CASE WHEN rn = 1 THEN visit_date END)) AS INTEGER) as gap
        FROM ranked_visits
        WHERE rn <= 2
        GROUP BY wallet_address
        HAVING COUNT(*) >= 2
      )
      SELECT
        (SELECT COUNT(*) FROM all_wallets) as total_unique_wallets,
        COUNT(*) as total_with_2plus,
        COUNT(CASE WHEN gap <= 30 THEN 1 END) as returned_30d
      FROM second_visits
    `).get();

    const total_unique_wallets = retornoRow?.total_unique_wallets || 0;
    const total2plus = retornoRow?.total_with_2plus || 0;
    const returned_30d = retornoRow?.returned_30d || 0;
    // % correcto: de todos los clientes, cuántos volvieron en 30 días
    const retorno_30d_pct = total_unique_wallets > 0 ? Math.round(returned_30d / total_unique_wallets * 100) : 0;

    // --- NUEVOS KPIs DE VALOR ---

    // 1. Media de visitas por cliente
    const avgVisitsRow = db.prepare(`
      SELECT AVG(visit_count) as avg_visits, MAX(visit_count) as max_visits
      FROM (
        SELECT wallet_address as w, COUNT(*) as visit_count
        FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date FROM sessions WHERE counted_as_visit = 1
          UNION
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date FROM visits
        ) GROUP BY w
      )
    `).get();

    // 2. Tasa de fidelización: % clientes con 3+ visitas (habituales reales)
    const loyaltyRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN visit_count >= 3 THEN 1 END) as loyal,
        COUNT(CASE WHEN visit_count = 1 THEN 1 END) as one_timers
      FROM (
        SELECT wallet_address as w, COUNT(*) as visit_count
        FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date FROM sessions WHERE counted_as_visit = 1
          UNION
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date FROM visits
        ) GROUP BY w
      )
    `).get();

    // 3. Clientes en zona de riesgo (última visita hace 30-45 días — aún rescatables)
    const churnRiskRow = db.prepare(`
      SELECT COUNT(*) as churn_risk
      FROM (
        SELECT wallet_address as w, MAX(visit_time) as last_visit
        FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time FROM sessions WHERE counted_as_visit = 1
          UNION ALL
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time FROM visits
        ) GROUP BY w
      )
      WHERE CAST(julianday('now') - julianday(last_visit) AS INTEGER) BETWEEN 30 AND 45
    `).get();

    // 4. Tasa de upgrade: % de clientes que escalaron de Nv1 a Nv2 o superior
    const upgradeRow = db.prepare(`
      SELECT COUNT(*) as upgraded
      FROM mints WHERE status != 'failed' AND level >= 2
      GROUP BY LOWER(wallet_address) HAVING COUNT(*) >= 1
    `).get();

    // 5 y 6. Mejor evento + crecimiento mensual — del motor de métricas (asistencia canónica).
    const _ov = metrics.getOverview();
    const bestEventRow = _ov.totals.best_event
      ? { title: _ov.totals.best_event.title, event_date: _ov.totals.best_event.event_date, attendees: _ov.totals.best_event.attendees }
      : null;
    const growthRow = { this_month: _ov.totals.new_this_month, last_month: _ov.totals.new_last_month };
    const growth_pct = _ov.totals.growth_pct;

    res.json({
      funnel,
      noshow,
      newByEvent,
      avg_gap: gapRow?.avg_gap ? Math.round(gapRow.avg_gap) : null,
      retorno_30d_pct,
      returned_30d,
      total_unique_wallets,
      total_with_2plus: total2plus,
      // Nuevos KPIs
      avg_visits_per_client: avgVisitsRow?.avg_visits ? Math.round(avgVisitsRow.avg_visits * 10) / 10 : null,
      max_visits_client: avgVisitsRow?.max_visits || null,
      loyalty_pct: loyaltyRow?.total > 0 ? Math.round(loyaltyRow.loyal / loyaltyRow.total * 100) : 0,
      loyal_count: loyaltyRow?.loyal || 0,
      one_timer_pct: loyaltyRow?.total > 0 ? Math.round(loyaltyRow.one_timers / loyaltyRow.total * 100) : 0,
      churn_risk_count: churnRiskRow?.churn_risk || 0,
      upgrade_count: upgradeRow?.upgraded || 0,
      upgrade_pct: total_unique_wallets > 0 ? Math.round((upgradeRow?.upgraded || 0) / total_unique_wallets * 100) : 0,
      best_event: bestEventRow || null,
      growth_this_month: growthRow?.this_month || 0,
      growth_last_month: growthRow?.last_month || 0,
      growth_pct,
      app_installs: require('../db/database').getAppInstallStats()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/segments — Segmentos de clientes
router.get('/segments', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');

    const nuevos = db.prepare(`
      WITH unified_visits AS (
        SELECT wallet_address, visit_date, MAX(visit_time) as visit_time FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time
          FROM sessions WHERE counted_as_visit = 1
          UNION ALL
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time
          FROM visits
        )
        GROUP BY wallet_address, visit_date
      )
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
        MIN(visit_time) as primera_visita,
        (SELECT SUM(p.points) FROM points p WHERE LOWER(p.wallet_address)=uv.wallet_address) as puntos
      FROM unified_visits uv
      GROUP BY wallet_address
      HAVING julianday('now') - julianday(MIN(visit_time)) < 45
      ORDER BY primera_visita DESC
    `).all();

    const habituales = db.prepare(`
      WITH unified_visits AS (
        SELECT wallet_address, visit_date, MAX(visit_time) as visit_time FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time
          FROM sessions WHERE counted_as_visit = 1
          UNION ALL
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time
          FROM visits
        )
        GROUP BY wallet_address, visit_date
      )
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
        COUNT(*) as total_visits,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=uv.wallet_address AND m.status='success') as nivel,
        (SELECT SUM(p.points) FROM points p WHERE LOWER(p.wallet_address)=uv.wallet_address) as puntos
      FROM unified_visits uv
      GROUP BY wallet_address HAVING COUNT(*) >= 3
      ORDER BY total_visits DESC
    `).all();

    const vip_candidatos = db.prepare(`
      WITH unified_visits AS (
        SELECT wallet_address, visit_date, MAX(visit_time) as visit_time FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time
          FROM sessions WHERE counted_as_visit = 1
          UNION ALL
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time
          FROM visits
        )
        GROUP BY wallet_address, visit_date
      )
      SELECT substr(uv.wallet_address,1,6)||'...'||substr(uv.wallet_address,-4) as wallet_masked,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=uv.wallet_address AND m.status='success') as nivel,
        COUNT(*) as visitas,
        MAX(visit_time) as ultima_visita
      FROM unified_visits uv
      GROUP BY uv.wallet_address
      HAVING COUNT(*) >= 2 AND (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=uv.wallet_address AND m.status='success') >= 2
      ORDER BY (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=uv.wallet_address AND m.status='success') DESC, COUNT(*) DESC
    `).all();

    const inactivos = db.prepare(`
      WITH unified_visits AS (
        SELECT wallet_address, visit_date, MAX(visit_time) as visit_time FROM (
          SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time
          FROM sessions WHERE counted_as_visit = 1
          UNION ALL
          SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time
          FROM visits
        )
        GROUP BY wallet_address, visit_date
      )
      SELECT substr(uv.wallet_address,1,6)||'...'||substr(uv.wallet_address,-4) as wallet_masked,
        CAST(julianday('now') - julianday(MAX(visit_time)) AS INTEGER) as dias_sin_visita,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=uv.wallet_address AND m.status='success') as nivel,
        COUNT(*) as total_visits
      FROM unified_visits uv
      GROUP BY uv.wallet_address
      HAVING CAST(julianday('now') - julianday(MAX(visit_time)) AS INTEGER) > 45 AND COUNT(*) >= 1
      ORDER BY dias_sin_visita DESC
    `).all();

    const con_app = db.prepare(`
      SELECT
        substr(a.wallet_address, 1, 6) || '...' || substr(a.wallet_address, -4) as wallet_masked,
        a.wallet_address,
        a.first_seen,
        EXISTS (
          SELECT 1 FROM sessions s WHERE LOWER(s.wallet_address) = LOWER(a.wallet_address) AND s.counted_as_visit = 1
          UNION
          SELECT 1 FROM visits v WHERE LOWER(v.wallet_address) = LOWER(a.wallet_address)
        ) as ha_venido,
        (
          SELECT COUNT(*) FROM (
            SELECT date(entry_time) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(a.wallet_address) AND counted_as_visit = 1
            UNION
            SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(a.wallet_address)
          )
        ) as total_visits
      FROM app_installs a
      ORDER BY a.first_seen DESC
    `).all();

    res.json({
      nuevos,
      habituales,
      vip_candidatos,
      inactivos,
      con_app,
      counts: {
        nuevos_count: nuevos.length,
        habituales_count: habituales.length,
        vip_count: vip_candidatos.length,
        inactivos_count: inactivos.length,
        con_app_count: con_app.length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/hourly?date=YYYY-MM-DD|totales — Aforo por hora (motor canónico)
// Delegado a services/metrics.js: misma definición de aforo/estancia/pico que el resto.
router.get('/hourly', requireAuth, (req, res) => {
  try {
    const date = req.query.date || '';
    if (!date) return res.status(400).json({ error: 'Falta date' });

    let data;
    if (date === 'totales') {
      data = metrics.getTotalsDetail();
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Formato de fecha no válido' });
      data = metrics.getEventDetail(date);
      if (!data) {
        // Evento sin fichajes todavía (programado) — responder estructura vacía coherente
        return res.json({
          date, hours_range: [], entries_by_hour: [], exits_by_hour: [], inside_by_hour: [],
          avg_duration: null, max_inside: 0, peak_hour: null, total_entries: 0, raffle_hours: []
        });
      }
    }
    delete data._stays; // detalle interno
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/metrics/overview — Resumen canónico por evento + globales (única fuente de verdad)
router.get('/metrics/overview', requireAuth, (req, res) => {
  try {
    res.json(metrics.getOverview());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/message-stats — Engagement de mensajes
router.get('/message-stats', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const rows = db.prepare(`
      SELECT m.id, m.subject, m.sent_at, m.recipient_count,
        COUNT(mr.id) as total_reactions,
        COUNT(DISTINCT mr.wallet_address) as unique_reactors
      FROM messages m LEFT JOIN message_reactions mr ON m.id=mr.message_id
      GROUP BY m.id ORDER BY m.sent_at DESC LIMIT 20
    `).all();

    const result = rows.map(row => {
      const emojiRows = db.prepare(`
        SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id=? GROUP BY emoji
      `).all(row.id);
      const engagement_pct = row.recipient_count > 0
        ? Math.round(row.unique_reactors / row.recipient_count * 100)
        : 0;
      return { ...row, emojis: emojiRows, engagement_pct };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/report-data?date=YYYY-MM-DD — Datos completos para PDF/reporte
router.get('/report-data', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const date = req.query.date || null;

    const stats = getStats();

    // stats.byLevel da el nivel EXCLUSIVo (MAX nivel por wallet). El funnel debe ser
    // ACUMULATIVO (igual que GET /api/admin/funnel): Nv2 = "alcanzaron Nv2 o más", para
    // que reconcilie con los recurrentes (quien vuelve es ≥ Nv2 por definición).
    const levelMap = {};
    stats.byLevel.forEach(r => { levelMap[r.level] = r.count; });
    const c1 = levelMap[1] || 0, c2 = levelMap[2] || 0, c3 = levelMap[3] || 0, c4 = levelMap[4] || 0;
    const nv4 = c4;
    const nv3 = c3 + nv4;
    const nv2 = c2 + nv3;
    const nv1 = c1 + nv2;

    // Aparición real con la MISMA definición de asistencia que el resto del panel (motor).
    const attendeesByDate = metrics.getAttendeeWalletsByDate();
    const noshow = db.prepare(`
      SELECT e.id, e.event_date, e.title,
        (SELECT COUNT(*) FROM rsvps WHERE event_id=e.id) as rsvp_count
      FROM events e WHERE e.active=1 ORDER BY e.event_date DESC LIMIT 6
    `).all().map(e => {
      const rsvpWallets = db.prepare(`SELECT LOWER(wallet_address) w FROM rsvps WHERE event_id=?`).all(e.id).map(r => r.w);
      const attended = new Set(attendeesByDate[e.event_date] || []);
      return { event_date: e.event_date, title: e.title, rsvp_count: e.rsvp_count,
               actual_count: rsvpWallets.filter(w => attended.has(w)).length };
    });

    const topPoints = db.prepare(`
      SELECT wallet_address, substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked, SUM(points) as total_points
      FROM points GROUP BY LOWER(wallet_address) ORDER BY total_points DESC LIMIT 8
    `).all();

    const segCounts = {
      nuevos_count: db.prepare(`
        WITH unified_visits AS (
          SELECT wallet_address, visit_date, MAX(visit_time) as visit_time FROM (
            SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date, entry_time as visit_time
            FROM sessions WHERE counted_as_visit = 1
            UNION ALL
            SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as visit_date, visited_at as visit_time
            FROM visits
          )
          GROUP BY wallet_address, visit_date
        )
        SELECT wallet_address FROM unified_visits
        GROUP BY wallet_address
        HAVING julianday('now') - julianday(MIN(visit_time)) < 45
      `).all().length,
      cerca_premio_count: db.prepare(`SELECT COUNT(*) as c FROM (SELECT LOWER(wallet_address) FROM points GROUP BY LOWER(wallet_address) HAVING SUM(points) BETWEEN 240 AND 299)`).get()?.c || 0
    };

    let hourly = null;
    if (date && date !== 'totales') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Formato de fecha inválido' });
      }
      const TZ = `'+2 hours'`;
      hourly = {
        entries_by_hour: db.prepare(`SELECT CAST(strftime('%H', entry_time, ${TZ}) AS INTEGER) as hour, COUNT(*) as count FROM sessions WHERE date(entry_time, ${TZ}) = date(?, ${TZ}) GROUP BY hour ORDER BY hour`).all(date)
      };
    }

    res.json({
      stats,
      funnel: [
        { level: 1, name: 'Nv1', count: nv1 },
        { level: 2, name: 'Nv2', count: nv2, pct: nv1 > 0 ? Math.round(nv2/nv1*100) : 0 },
        { level: 3, name: 'Nv3', count: nv3, pct: nv2 > 0 ? Math.round(nv3/nv2*100) : 0 },
        { level: 4, name: 'Nv4', count: nv4, pct: nv3 > 0 ? Math.round(nv4/nv3*100) : 0 }
      ],
      noshow,
      topPoints,
      segCounts,
      hourly,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/inspect-wallet/:address — Inspeccionar un furancheiro específico (admin)
router.get('/inspect-wallet/:address', requireAuth, (req, res) => {
  const { address } = req.params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Dirección no válida' });
  }
  try {
    const { db, getVisitCount, getClaimedLevels } = require('../db/database');

    // Nivel del holder
    const holder = db.prepare(`
      SELECT level, level_name, minted_at FROM mints
      WHERE wallet_address = ? AND status = 'success'
      ORDER BY level DESC LIMIT 1
    `).get(address);
    
    // Última sesión/visita
    const lastSession = db.prepare(`
      SELECT entry_time, exit_time FROM sessions
      WHERE wallet_address = ?
      ORDER BY entry_time DESC LIMIT 1
    `).get(address);
    
    const level = holder ? holder.level : 1;
    const levelName = holder ? holder.level_name : 'Cautivo';
    const visitCount = getVisitCount(address);

    // Tapas por día de evento (solo días con evento registrado, counted_as_visit=1)
    const tapasByDay = db.prepare(`
      SELECT
        date(s.entry_time, '+2 hours') as day,
        e.title as event_title,
        COUNT(*) as tapas
      FROM sessions s
      LEFT JOIN events e ON date(s.entry_time) = e.event_date
      WHERE s.wallet_address = ? AND s.counted_as_visit = 1
      GROUP BY day
      ORDER BY day DESC
      LIMIT 20
    `).all(address);

    // Sesión actual (si está dentro ahora)
    const activeSession = db.prepare(`
      SELECT entry_time FROM sessions
      WHERE wallet_address = ? AND exit_time IS NULL
      ORDER BY entry_time DESC LIMIT 1
    `).get(address);

    // Premios NFT ganados en sorteos y aún sin entregar en persona: el Escáner
    // enseña el banner "Otorgar NFT" igual que la página de camareros.
    let pendingNftPrizes = [];
    try {
      const { getPendingNftPrizes } = require('../db/database');
      const achievements = require('../services/achievements');
      pendingNftPrizes = (getPendingNftPrizes(address) || []).map(r => {
        const a = achievements.getById(r.nft_achievement_id);
        return {
          source: r.source || 'raffle',
          raffleId: r.raffleId || null,
          week: r.week || null,
          prize: r.prize,
          achievementId: r.nft_achievement_id,
          achievementName: a ? a.name : r.nft_achievement_id,
          achievementImage: a ? a.image : (r.prize_image || null)
        };
      });
    } catch (_) {}

    let vipReservations = [];
    try {
      const today = new Date().toISOString().slice(0, 10);
      vipReservations = db.prepare(`
        SELECT vr.event_id, vr.status, vr.group_size, vr.alias, vr.notes, e.title, e.event_date
        FROM vip_reservations vr
        JOIN events e ON e.id = vr.event_id
        WHERE vr.wallet_address = ? AND e.event_date >= ? AND vr.status != 'cancelled'
        ORDER BY e.event_date ASC
      `).all(address, today);
    } catch (_) {}

    // Privilexio do Guardián (tapa do día ligada a NFT): misma fuente única que la
    // tarjeta del cliente y el fichaje de staff. Así, al escanear el ID Socio de un
    // guardián, el admin VE el privilexio y puede consumirlo desde aquí mismo.
    let dailyTapa = null;
    try {
      const { computeDailyTapaStatus } = require('./mint');
      const tapa = computeDailyTapaStatus(address);
      dailyTapa = tapa && tapa.visible ? tapa : null;
    } catch (_) {}

    // Bonos de sorteo del cliente: aceptados por canjear y pendientes de aceptar.
    // (Los premios NFT van aparte, en pendingNftPrizes, con su botón de entrega.)
    let prizes = [];
    try {
      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
      prizes = db.prepare(`
        SELECT id, prize, status, verification_code, establishment, validity_end_date
        FROM raffles
        WHERE LOWER(winner_wallet) = LOWER(?)
          AND nft_achievement_id IS NULL
          AND (
            status = 'accepted'
            OR (status = 'pending_acceptance' AND acceptance_deadline > ?)
          )
        ORDER BY created_at DESC LIMIT 10
      `).all(address, nowStr).map(r => ({
        raffleId: r.id,
        prize: r.prize,
        status: r.status,
        code: r.status === 'accepted' ? r.verification_code : null,
        establishment: r.establishment || null,
        validityEndDate: r.validity_end_date || null
      }));
    } catch (_) {}

    res.json({
      walletAddress: address,
      level,
      levelName,
      visitCount,
      lastVisit: lastSession ? lastSession.entry_time : (holder ? holder.minted_at : null),
      activeNow: !!activeSession,
      activeSessionStart: activeSession ? activeSession.entry_time : null,
      claimedLevels: getClaimedLevels(address),
      tapasByDay,
      pendingNftPrizes,
      vipReservations,
      dailyTapa,
      prizes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/polygon-balance — saldo de la billetera que paga el gas de los mints
router.get('/polygon-balance', requireAuth, async (_req, res) => {
  try {
    const { getMinterBalance } = require('../services/polygon');
    res.json(await getMinterBalance());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/nft-backfill/preview — qué NFT de la época demo faltan on-chain.
// SOLO LECTURA (no gasta gas): lee la cadena para saltar lo ya minteado.
router.get('/nft-backfill/preview', requireAuth, async (_req, res) => {
  try {
    const polygon = require('../services/polygon');
    if (polygon.DEMO_MODE) return res.json({ demo: true, toMint: 0, alreadyOnchain: 0, candidates: [], message: 'Modo demo activo — no hay minteo on-chain.' });
    const { getDemoLevelMints, getDemoAchievementMints } = require('../db/database');
    const jobs = [
      ...getDemoLevelMints().map(m => ({ kind: 'level', wallet: m.wallet_address, tokenId: m.level, label: `Nv${m.level} ${m.level_name}` })),
      ...getDemoAchievementMints().map(m => ({ kind: 'achievement', wallet: m.wallet_address, tokenId: m.token_id, label: `Logro ${m.achievement_id}` }))
    ];
    const candidates = [];
    let alreadyOnchain = 0;
    for (const j of jobs) {
      let bal = 0;
      try { bal = await polygon.getOnchainBalance(j.wallet, j.tokenId); } catch (e) { bal = 0; }
      if (bal > 0) { alreadyOnchain++; continue; }
      candidates.push(j);
    }
    res.json({ demo: false, totalDemoRecords: jobs.length, alreadyOnchain, toMint: candidates.length, candidates: candidates.slice(0, 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/nft-backfill/run — mintea on-chain los pendientes de la época demo.
// ⚠️ GASTA GAS. Acotado por lote (default 10, máx 25) para no exceder el timeout HTTP.
// Salta lo que ya esté en la cadena. Repetir hasta que remaining = 0.
router.post('/nft-backfill/run', requireAuth, async (req, res) => {
  try {
    const polygon = require('../services/polygon');
    if (polygon.DEMO_MODE) return res.status(400).json({ error: 'Modo demo activo — nada que mintear.' });
    const { getDemoLevelMints, getDemoAchievementMints, updateMintStatus, updateAchievementMintStatus } = require('../db/database');
    const limit = Math.min(parseInt(req.body?.limit) || 10, 25);
    const out = { minted: 0, skipped: 0, failed: 0, remaining: 0, details: [] };

    const jobs = [
      ...getDemoLevelMints().map(m => ({ kind: 'level', id: m.id, wallet: m.wallet_address, level: m.level, tokenId: m.level, label: `Nv${m.level} ${m.level_name}` })),
      ...getDemoAchievementMints().map(m => ({ kind: 'achievement', id: m.id, wallet: m.wallet_address, tokenId: m.token_id, label: `Logro ${m.achievement_id}` }))
    ];

    let mintsThisRun = 0;
    for (const j of jobs) {
      let bal = 0;
      try { bal = await polygon.getOnchainBalance(j.wallet, j.tokenId); } catch (e) { bal = 0; }
      if (bal > 0) { out.skipped++; continue; }
      if (mintsThisRun >= limit) { out.remaining++; continue; }
      try {
        const r = await polygon.mintNFT({ walletAddress: j.wallet, tokenId: j.tokenId, level: j.kind === 'level' ? j.level : undefined, levelName: j.label });
        if (j.kind === 'level') updateMintStatus(j.id, 'success', j.wallet, r.txHash, r.costMatic || null);
        else updateAchievementMintStatus(j.id, 'success', r.txHash, r.costMatic || null);
        out.minted++; mintsThisRun++;
        out.details.push({ wallet: j.wallet, label: j.label, txHash: r.txHash });
      } catch (e) {
        out.failed++;
        out.details.push({ wallet: j.wallet, label: j.label, error: e.message });
      }
    }
    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/pending-mints — lista de NFTs esperando aprobación
router.get('/pending-mints', requireAuth, (_req, res) => {
  try {
    const { getPendingApprovalAchievements } = require('../db/database');
    const achievements = require('../services/achievements');

    const levelMints = getPendingApprovalMints().map(m => ({
      id: m.id,
      type: 'level',
      wallet_address: m.wallet_address,
      wallet_masked: `${m.wallet_address.slice(0, 6)}...${m.wallet_address.slice(-4)}`,
      level: m.level,
      level_name: m.level_name,
      minted_at: m.minted_at,
      visit_count: getVisitCount(m.wallet_address)
    }));

    const achievementMints = getPendingApprovalAchievements().map(m => {
      const ach = achievements.getById(m.achievement_id);
      return {
        id: m.id,
        type: 'achievement',
        wallet_address: m.wallet_address,
        wallet_masked: `${m.wallet_address.slice(0, 6)}...${m.wallet_address.slice(-4)}`,
        achievement_id: m.achievement_id,
        achievement_name: ach ? ach.name : m.achievement_id,
        minted_at: m.created_at,
        visit_count: getVisitCount(m.wallet_address)
      };
    });

    const allMints = [...levelMints, ...achievementMints].sort((a, b) => {
      const dateA = new Date(a.minted_at || 0);
      const dateB = new Date(b.minted_at || 0);
      return dateA - dateB;
    });

    res.json(allMints);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/reconcile-mints — fuerza la sincronización de niveles por si alguien saltó una visita
router.post('/reconcile-mints', requireAuth, (req, res) => {
  try {
    const { reconcileMints } = require('../scripts/reconcile_mints');
    const added = reconcileMints();
    res.json({ success: true, added, message: `Se han añadido ${added} mints pendientes o exitosos que faltaban.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mints/:id/approve — aprueba el mint y lo manda a la cola blockchain
router.post('/mints/:id/approve', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const type = req.query.type || 'level';
    if (type === 'achievement') {
      const { approveAchievementMint } = require('../db/database');
      const { notifyAchievementQueue } = require('../services/polygon');
      approveAchievementMint(id);
      notifyAchievementQueue();
    } else {
      const { approveMint } = require('../db/database');
      approveMint(id);
      const { notifyQueue } = require('../services/polygon');
      notifyQueue();
    }
    res.json({ success: true, message: '¡Aprobado! El NFT entrará en la cola de Polygon ahora mismo.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mints/:id/reject — rechaza el mint (no se mintea nada)
router.post('/mints/:id/reject', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const type = req.query.type || 'level';
    if (type === 'achievement') {
      const { rejectAchievementMint } = require('../db/database');
      rejectAchievementMint(id);
    } else {
      const { rejectMint } = require('../db/database');
      rejectMint(id);
    }
    res.json({ success: true, message: 'Mint rechazado correctamente.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CAMPAÑA "RETO DE LOS 5" ─────────────────────────────────────────────────

// GET /api/admin/campaign/stats — resumen de la campaña + ranking + pendientes de aprobar.
router.get('/campaign/stats', requireAuth, (req, res) => {
  try {
    const campaign = require('../services/campaign');
    const { getPendingApprovalAchievements, getCampaignVisitCount } = require('../db/database');
    const achievements = require('../services/achievements');
    // Solo los pendientes del logro de esta campaña.
    const pending = getPendingApprovalAchievements()
      .filter(p => p.achievement_id === campaign.CAMPAIGN.achievementId)
      .map(p => ({
        id: p.id,
        wallet: p.wallet_address,
        visits: getCampaignVisitCount(p.wallet_address),
        createdAt: p.created_at
      }));
    const legend = achievements.getById(campaign.CAMPAIGN.achievementId);
    res.json({
      active: campaign.isCampaignActive(),
      campaign: { name: campaign.CAMPAIGN.name, startDate: campaign.CAMPAIGN.startDate, endDate: campaign.CAMPAIGN.endDate, required: campaign.CAMPAIGN.requiredVisits },
      stats: campaign.getStats(),
      leaderboard: campaign.getLeaderboard(10),
      pending,
      nftImage: legend ? legend.image : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/campaign/:id/approve — aprueba el NFT de un cliente que completó el reto
// y lo manda a la cola de minteo (Polygon).
router.post('/campaign/:id/approve', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { approveAchievementMint } = require('../db/database');
    const { notifyAchievementQueue } = require('../services/polygon');
    approveAchievementMint(id);
    notifyAchievementQueue();
    res.json({ success: true, message: '¡Aprobado! El NFT Furancho Legend entrará en la cola de Polygon.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/campaign/:id/reject — rechaza el NFT (no se mintea nada).
router.post('/campaign/:id/reject', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rejectAchievementMint } = require('../db/database');
    rejectAchievementMint(id);
    res.json({ success: true, message: 'NFT de campaña rechazado.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/campaign/image — persiste la imagen del logro Furancho Legend 2026.
// La subida física (multipart) la sigue haciendo /api/raffle/upload-image (patrón ya
// usado por otros logros). Aquí solo guardamos la URL en achievement_overrides para
// que sobreviva a reinicios sin tocar código.
router.post('/campaign/image', requireAuth, (req, res) => {
  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== 'string' || !/^\/prize-images\//.test(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl debe ser una ruta /prize-images/…' });
  }
  try {
    const campaign = require('../services/campaign');
    const { setAchievementImageOverride } = require('../db/database');
    setAchievementImageOverride(campaign.CAMPAIGN.achievementId, imageUrl);
    res.json({ success: true, message: 'Imagen del NFT actualizada.', imageUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/campaign/privileges — lee los privilegios de vuelta de septiembre para +5 y +10.
router.get('/campaign/privileges', requireAuth, (req, res) => {
  try {
    const campaign = require('../services/campaign');
    const tiers = campaign.getPrivilegeTiers();
    const tier5 = tiers.find(t => t.minVisits === 5);
    const tier10 = tiers.find(t => t.minVisits === 10);
    res.json({
      perks5: tier5 ? tier5.perks : [],
      perks10: tier10 ? tier10.perks : []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/campaign/privileges — guarda los privilegios editados desde el panel admin (+5 y +10).
router.post('/campaign/privileges', requireAuth, (req, res) => {
  const { perks5, perks10 } = req.body || {};
  try {
    const campaign = require('../services/campaign');
    const updatedTiers = campaign.savePrivileges(perks5, perks10);
    res.json({
      success: true,
      message: 'Privilegios de septiembre actualizados.',
      privilegeTiers: updatedTiers
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/admin/mints/delete — borra un pase concreto (wallet + nivel), sea cual sea
// su estado. Para corregir niveles asignados por error o limpiar wallets de prueba
// (reject/clearStaleMint solo tocan pendientes, no un mint ya en 'success'). Solo admin.
router.post('/mints/delete', requireAuth, (req, res) => {
  const { walletAddress, level } = req.body;
  const ethRegex = /^0x[a-fA-F0-9]{40}$/i;
  if (!walletAddress || !ethRegex.test(walletAddress)) return res.status(400).json({ error: 'Wallet inválida' });
  const lvl = parseInt(level);
  if (![1, 2, 3, 4].includes(lvl)) return res.status(400).json({ error: 'Level debe ser 1, 2, 3 o 4' });
  try {
    const { db } = require('../db/database');
    const r = db.prepare(`DELETE FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ?`).run(walletAddress, lvl);
    res.json({ success: true, deleted: r.changes, walletAddress, level: lvl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mint-direct — mintea directamente un nivel a una wallet (sin visitas, sin Crossmint)
router.post('/mint-direct', requireAuth, (req, res) => {
  const { walletAddress, level, mintCostMatic } = req.body;
  if (!walletAddress || !level) return res.status(400).json({ error: 'Faltan walletAddress y level' });
  const lvl = parseInt(level);
  if (![1,2,3,4].includes(lvl)) return res.status(400).json({ error: 'Level debe ser 1, 2, 3 o 4' });
  const ethRegex = /^0x[a-fA-F0-9]{40}$/i;
  if (!ethRegex.test(walletAddress)) return res.status(400).json({ error: 'Wallet inválida' });
  try {
    const { db, insertMint, clearStaleMint } = require('../db/database');
    const LEVEL_NAMES = { 1: 'O Cautivo', 2: 'O Cunqueiro', 3: 'O Larpeiro', 4: 'O Presidente' };
    // Comprobar si ya existe este nivel para esta wallet
    const existing = db.prepare(`SELECT id FROM mints WHERE wallet_address = ? AND level = ? AND status != 'failed'`).get(walletAddress, lvl);
    if (existing) {
      return res.status(409).json({ error: `Esta wallet ya tiene el Nivel ${lvl} (${LEVEL_NAMES[lvl]}) asignado` });
    }
    clearStaleMint(walletAddress, lvl);
    // Nv1/Nv2 son off-chain (success directo). Nv3/Nv4 van a la blockchain real.
    const onChain = lvl >= 3;
    const initialStatus = onChain ? 'pending' : 'success';
    const id = insertMint({ email: null, level: lvl, levelName: LEVEL_NAMES[lvl], walletAddress, status: initialStatus, ipAddress: 'admin-direct' });
    const cost = mintCostMatic ? parseFloat(mintCostMatic) : null;
    db.prepare(`UPDATE mints SET mint_cost_matic = ?, mint_source = 'admin-manual' WHERE id = ?`).run(cost, id);
    if (onChain) {
      const { notifyQueue } = require('../services/polygon');
      notifyQueue();
    }
    res.json({ success: true, id, level: lvl, levelName: LEVEL_NAMES[lvl], walletAddress, queued: onChain });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/grant-achievement — otorga un logro NFT a una wallet por decisión del
// admin (sin requisito de asistencia; autoridad admin). Encola el mint on-chain.
router.post('/grant-achievement', requireAuth, (req, res) => {
  const { walletAddress, achievementId } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) return res.status(400).json({ error: 'Wallet inválida' });
  const achievements = require('../services/achievements');
  const a = achievements.getById(achievementId);
  if (!a) return res.status(404).json({ error: 'Logro no encontrado' });
  try {
    const { db, claimAchievement, getAchievementMint } = require('../db/database');

    // El meme se lleva por la tienda (services/memeShop.js): cuenta contra las 300
    // y deja registrada la unidad. Aquí es un REGALO (sin extras, no se cobra).
    // Sigue siendo idempotente como antes: si ya tiene meme no se le cuela otro
    // por un doble toque — para venderle un segundo está la tienda, que avisa
    // del precio. Un meme regalado de más no se puede deshacer: son 300 y punto.
    if (a.id === 'meme_vip') {
      const existingMeme = getAchievementMint(walletAddress, a.id);
      if (existingMeme) {
        return res.json({ success: true, alreadyGranted: true, status: existingMeme.status, achievementId: a.id });
      }
      const shop = require('../services/memeShop');
      const out = shop.sellTo(walletAddress, { source: 'regalo', priceCents: 0, withPerks: false });
      return res.json({ success: true, status: 'pending', achievementId: a.id, name: a.name, serial: out.serial, supply: out.supply });
    }

    // Validar límite máximo (maxSupply)
    if (a.maxSupply) {
      const countQuery = db.prepare(`SELECT COUNT(*) as count FROM achievement_mints WHERE achievement_id = ? AND status != 'failed'`).get(a.id);
      const currentSupply = countQuery ? countQuery.count : 0;
      if (currentSupply >= a.maxSupply) {
        return res.status(400).json({ error: `Se ha alcanzado el límite máximo de ${a.maxSupply} unidades para este logro.` });
      }
    }

    const existing = getAchievementMint(walletAddress, a.id);
    if (existing) return res.json({ success: true, alreadyGranted: true, status: existing.status, achievementId: a.id });
    claimAchievement(walletAddress, a.id, a.tokenId);
    require('../services/polygon').notifyAchievementQueue();
    res.json({ success: true, status: 'pending', achievementId: a.id, name: a.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mint-meme — vende/entrega una unidad del "Meme VIP" (token 50).
// Delega en services/memeShop.js: allí viven el límite irreversible de 300, el
// precio creciente por unidad y lo que incluye. Se mantiene la ruta de siempre
// para no romper el botón antiguo del panel.
// Body: { walletAddress, priceCents?, source?: 'venta'|'regalo', withPerks? }
router.post('/mint-meme', requireAuth, (req, res) => {
  const { walletAddress, priceCents, source, withPerks } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) return res.status(400).json({ error: 'Wallet inválida' });
  try {
    const shop = require('../services/memeShop');
    const out = shop.sellTo(walletAddress, {
      source: source === 'regalo' ? 'regalo' : 'venta',
      priceCents: (priceCents === undefined || priceCents === null || priceCents === '') ? null : parseInt(priceCents, 10),
      withPerks: withPerks !== false
    });
    res.json({ success: true, status: 'pending', achievementId: 'meme_vip', serial: out.serial, supply: out.supply, perks: out.perks });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── TEST RAFFLE — endpoints temporales para probar el flujo completo ────────
// POST /api/admin/test-raffle/setup — crea sesiones de prueba para hoy
// POST /api/admin/test-raffle/cleanup — borra TODO rastro del test
const TEST_WALLETS = [
  '0xTEST000000000000000000000000000000000001',
  '0xTEST000000000000000000000000000000000002',
  '0xTEST000000000000000000000000000000000003',
  '0xTEST000000000000000000000000000000000004',
];

router.post('/test-raffle/setup', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const now = new Date();
    const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const today = `${madridTime.getFullYear()}-${String(madridTime.getMonth()+1).padStart(2,'0')}-${String(madridTime.getDate()).padStart(2,'0')}`;
    const entryTime = `${today} 19:00:00`;

    // Wallets de prueba fijos
    const allWallets = [...TEST_WALLETS];

    // Si el admin pasa wallets extra (p.ej. el wallet real del tester)
    const extra = req.body.extraWallets || [];
    extra.forEach(w => { if (w && !allWallets.includes(w)) allWallets.push(w); });

    let inserted = 0;
    const stmt = db.prepare(`INSERT OR IGNORE INTO sessions (wallet_address, entry_time, exit_time) VALUES (?, ?, NULL)`);
    for (const w of allWallets) {
      stmt.run(w, entryTime);
      inserted++;
    }

    // También en mints para que aparezcan como holders nivel 1
    const mintStmt = db.prepare(`INSERT OR IGNORE INTO mints (wallet_address, level, level_name, status, event_date) VALUES (?, 1, 'CAUTIVO', 'completed', ?)`);
    for (const w of allWallets) {
      mintStmt.run(w, today);
    }

    console.log(`[TestRaffle] Setup: ${inserted} sesiones de prueba creadas para ${today}`);
    res.json({ success: true, wallets: allWallets, count: inserted, date: today, message: `${inserted} fichas de prueba creadas. Lanza el sorteo desde el admin ahora.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/test-raffle/cleanup', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');

    // Borrar sesiones de test
    const s1 = db.prepare(`DELETE FROM sessions WHERE wallet_address LIKE '0xTEST%'`).run();
    // Borrar mints de test
    const s2 = db.prepare(`DELETE FROM mints WHERE wallet_address LIKE '0xTEST%'`).run();
    // Borrar puntos y visitas de test
    db.prepare(`DELETE FROM points WHERE wallet_address LIKE '0xTEST%'`).run();
    try { db.prepare(`DELETE FROM visits WHERE wallet_address LIKE '0xTEST%'`).run(); } catch(_) {}
    try { db.prepare(`DELETE FROM weekly_claims WHERE wallet_address LIKE '0xTEST%'`).run(); } catch(_) {}
    // Borrar sorteos de test (participants que incluyan test wallets)
    // Raffles: borrar entradas de prueba de raffle_participants
    const raffleSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='raffle_participants'").get();
    let s3 = { changes: 0 };
    if (raffleSchema) {
      s3 = db.prepare(`DELETE FROM raffle_participants WHERE wallet_address LIKE '0xTEST%'`).run();
    }
    // Borrar raffles que solo tuvieron test wallets como ganador
    const s4 = db.prepare(`DELETE FROM raffles WHERE winner_wallet LIKE '0xTEST%'`).run();

    const total = s1.changes + s2.changes + s3.changes + s4.changes;
    console.log(`[TestRaffle] Cleanup: ${total} registros de prueba eliminados`);
    res.json({ success: true, deleted: { sessions: s1.changes, mints: s2.changes, raffleParticipants: s3.changes, raffles: s4.changes }, message: `Todo limpio para el jueves 🍷` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


const {
  getPendingTransfers,
  getTransferById,
  updateTransferStatus,
  getAppSetting,
  setAppSetting
} = require('../db/transfers');
const { executeTransferOnChain } = require('../services/polygon');

// GET /api/admin/settings/:key
router.get('/settings/:key', requireAuth, (req, res) => {
  try {
    const value = getAppSetting(req.params.key);
    res.json({ key: req.params.key, value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/settings/:key
router.post('/settings/:key', requireAuth, (req, res) => {
  try {
    const { value } = req.body;
    setAppSetting(req.params.key, value);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/daily-tapa-config — configuración del beneficio "tapa do día" ligado a un NFT
router.get('/daily-tapa-config', requireAuth, (req, res) => {
  try {
    const achievements = require('../services/achievements');
    const nftRaw = getAppSetting('daily_tapa_nft', 'guardian_furancho');
    res.json({
      enabled: getAppSetting('daily_tapa_enabled', '0') === '1',
      nft: nftRaw,
      // Lista (puede haber VARIOS NFTs; el privilexio se acumula: 1 tapa por NFT al día)
      nfts: String(nftRaw).split(',').map(s => s.trim()).filter(Boolean),
      from: getAppSetting('daily_tapa_from', ''),
      to: getAppSetting('daily_tapa_to', ''),
      title: getAppSetting('daily_tapa_title', 'Privilexio do Guardián'),
      benefit: getAppSetting('daily_tapa_benefit', 'Tapa e cunca do día'),
      button: getAppSetting('daily_tapa_button', '🎟️ Mostrar mi vale'),
      // Solo NFT de logro (token >= 50), no los niveles 1-4, para el desplegable.
      achievements: achievements.list().map(a => ({ id: a.id, name: a.name, tokenId: a.tokenId }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/daily-tapa-config — guarda toda la configuración de golpe
router.post('/daily-tapa-config', requireAuth, (req, res) => {
  try {
    const { enabled, nft, nfts, from, to, title, benefit, button } = req.body || {};
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'Fecha "desde" no válida' });
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Fecha "hasta" no válida' });
    if (from && to && to < from) return res.status(400).json({ error: 'La fecha "hasta" no puede ser anterior a "desde"' });

    // Acepta uno o varios NFTs (array `nfts` o string con comas en `nft`); todos deben
    // existir en el catálogo de logros. El privilexio se acumula: 1 tapa por NFT al día.
    const rawList = Array.isArray(nfts) ? nfts : String(nft || '').split(',');
    const nftList = rawList.map(s => String(s).trim()).filter(Boolean);
    if (enabled && !nftList.length) return res.status(400).json({ error: 'Elige el NFT (o NFTs) que desbloquean el beneficio' });
    const achievements = require('../services/achievements');
    const known = new Set(achievements.list().map(a => a.id));
    const bad = nftList.filter(id => !known.has(id));
    if (bad.length) return res.status(400).json({ error: `NFT desconocido: ${bad.join(', ')}` });

    setAppSetting('daily_tapa_enabled', enabled ? '1' : '0');
    setAppSetting('daily_tapa_nft', nftList.length ? nftList.join(',') : 'guardian_furancho');
    setAppSetting('daily_tapa_from', from || '');
    setAppSetting('daily_tapa_to', to || '');
    setAppSetting('daily_tapa_title', String(title || '').trim() || 'Privilexio do Guardián');
    setAppSetting('daily_tapa_benefit', String(benefit || '').trim() || 'Tapa e cunca do día');
    setAppSetting('daily_tapa_button', String(button || '').trim() || '🎟️ Mostrar mi vale');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/transfers
router.get('/transfers', requireAuth, (req, res) => {
  try {
    res.json(getPendingTransfers());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/transfers/:id/approve
router.post('/transfers/:id/approve', requireAuth, async (req, res) => {
  try {
    const transfer = getTransferById(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    
    // Execute on-chain
    const { from_wallet, to_wallet, token_id, private_key_enc } = transfer;
    const result = await executeTransferOnChain(from_wallet, to_wallet, token_id, private_key_enc);

    // Update status
    updateTransferStatus(transfer.id, 'success', result.txHash);

    // La propiedad en la app sigue al NFT: para logros (tokens fuera de 1-4) movemos el
    // registro a la wallet destino, conservando la fila (y por tanto su nº de serie), que
    // es lo que espera el anti-trampas de la tapa diaria. Los niveles 1-4 NO se tocan:
    // el historial de visitas es de quien lo ganó; solo viaja el coleccionable on-chain.
    if (token_id < 1 || token_id > 4) {
      try {
        const { db } = require('../db/database');
        const row = db.prepare(`
          SELECT id, achievement_id FROM achievement_mints
          WHERE LOWER(wallet_address) = LOWER(?) AND token_id = ? AND status = 'success'
          ORDER BY id ASC LIMIT 1
        `).get(from_wallet, token_id);
        if (row) {
          // Si el destinatario YA tenía ese logro, no se puede mover la fila
          // (hay un UNIQUE por wallet+logro): en ese caso se borra la del origen,
          // que es lo que refleja la realidad on-chain (ya no lo tiene él).
          const yaLoTiene = db.prepare(`SELECT id FROM achievement_mints
            WHERE LOWER(wallet_address) = LOWER(?) AND achievement_id = ? AND status != 'failed'`)
            .get(to_wallet, row.achievement_id);
          if (yaLoTiene) {
            db.prepare(`DELETE FROM achievement_mints WHERE id = ?`).run(row.id);
          } else {
            db.prepare(`UPDATE achievement_mints SET wallet_address = ? WHERE id = ?`).run(to_wallet, row.id);
          }
        }
        // El meme lleva además su unidad vendida (precio y recuento de las 300).
        if (Number(token_id) === 50) {
          require('../services/memeShop').moveUnitOnTransfer(from_wallet, to_wallet);
        }
      } catch (moveErr) {
        console.error('[Transfers] Traspaso on-chain OK pero fallo moviendo el logro en BD:', moveErr.message);
      }
    }

    res.json({ success: true, txHash: result.txHash });
  } catch (e) {
    console.error(e);
    updateTransferStatus(req.params.id, 'failed');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/transfers/:id/reject
router.post('/transfers/:id/reject', requireAuth, (req, res) => {
  try {
    updateTransferStatus(req.params.id, 'rejected');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// POST /api/admin/claim-daily-tapa
// Registra el canje físico de la tapa gratis y consumición do día.
// Delega en registerDailyTapaClaim (db/database.js), fuente única compartida con /staff.
router.post('/claim-daily-tapa', requireAuth, (req, res) => {
  const { walletAddress, nftType, nftId, serial, sig } = req.body;
  try {
    const { registerDailyTapaClaim } = require('../db/database');
    registerDailyTapaClaim({ walletAddress, nftType, nftId, serial, sig, staffUser: 'admin' });
    res.json({ success: true, message: 'Canje de tapa registrado con éxito.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.verifyAdminToken = verifyToken;

// GET /api/admin/partners-public (PÚBLICO para clientes móviles)
router.get('/partners-public', (req, res) => {
  try {
    const { getPartnerEstablishments } = require('../db/database');
    const partners = getPartnerEstablishments();
    const masked = partners.map(p => {
      if (p.visible === 1) {
        return p;
      } else {
        return {
          id: p.id,
          name: "Local Colaborador",
          story: "¡Brevemente nuestros amigos furancheiros! 🤫",
          maps_url: null,
          visible: 0
        };
      }
    });
    res.json(masked);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/partners (ADMIN ONLY)
router.get('/partners', requireAuth, (req, res) => {
  try {
    const partners = getPartnerEstablishments();
    res.json(partners);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/partners (ADMIN ONLY)
router.post('/partners', requireAuth, (req, res) => {
  const { id, name, mapsUrl, story, visible } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const partnerId = upsertPartnerEstablishment({
      id: id ? parseInt(id) : null,
      name: name.trim(),
      mapsUrl: mapsUrl ? mapsUrl.trim() : null,
      story: story ? story.trim() : null,
      visible: visible !== undefined ? !!visible : true
    });
    res.json({ success: true, id: partnerId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/partners/:id (ADMIN ONLY)
router.delete('/partners/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    deletePartnerEstablishment(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/scheduled-messages (ADMIN ONLY)
router.get('/scheduled-messages', requireAuth, (req, res) => {
  try {
    const { getScheduledMessages } = require('../db/database');
    res.json(getScheduledMessages());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/scheduled-messages (ADMIN ONLY)
router.post('/scheduled-messages', requireAuth, (req, res) => {
  const { id, subject, body, levelFilter, rsvpEventId, actionType, sendAt } = req.body;
  if (!subject || !body || !sendAt) {
    return res.status(400).json({ error: 'Asunto, cuerpo y fecha/hora de envío son obligatorios' });
  }
  try {
    const { insertScheduledMessage, updateScheduledMessage } = require('../db/database');
    if (id) {
      updateScheduledMessage(parseInt(id), { subject, body, levelFilter, rsvpEventId, actionType, sendAt });
      res.json({ success: true, id: parseInt(id) });
    } else {
      const newId = insertScheduledMessage({ subject, body, levelFilter, rsvpEventId, actionType, sendAt });
      res.json({ success: true, id: newId });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/scheduled-messages/:id (ADMIN ONLY)
router.delete('/scheduled-messages/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { deleteScheduledMessage } = require('../db/database');
    deleteScheduledMessage(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CUENTAS REGRESIVAS ────────────────────────────────────────────────────────

// GET /api/admin/countdowns — público: clientes ven las activas
router.get('/countdowns-public', (req, res) => {
  try {
    const { getActiveCountdowns } = require('../db/database');
    const rows = getActiveCountdowns();
    res.json(rows.map(r => ({
      id: r.id, title: r.title, subtitle: r.subtitle, emoji: r.emoji,
      targetDate: r.target_date, logoPath: r.logo_path, theme: r.theme,
      endMessage: r.end_message, hideAfterEnd: !!r.hide_after_end, sortOrder: r.sort_order
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/countdowns (ADMIN ONLY) — todas, incluidas inactivas
router.get('/countdowns', requireAuth, (req, res) => {
  try {
    const { getAllCountdowns } = require('../db/database');
    res.json(getAllCountdowns());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/countdowns (ADMIN ONLY) — crear o actualizar
router.post('/countdowns', requireAuth, (req, res) => {
  const { id, title, subtitle, emoji, target_date, theme, end_message, hide_after_end, active, sort_order } = req.body;
  if (!title || !target_date) return res.status(400).json({ error: 'Título y fecha objetivo son obligatorios' });
  try {
    const { createCountdown: create, updateCountdown: update } = require('../db/database');
    if (id) {
      update(parseInt(id), { title, subtitle, emoji, target_date, theme, end_message, hide_after_end, active, sort_order });
      res.json({ success: true, id: parseInt(id) });
    } else {
      const newId = create({ title, subtitle, emoji, target_date, theme, end_message, hide_after_end, sort_order });
      res.json({ success: true, id: newId });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/countdowns/:id/logo (ADMIN ONLY) — subir logo
router.post('/countdowns/:id/logo', requireAuth, cdUpload.single('logo'), (req, res) => {
  const cdId = parseInt(req.params.id);
  if (isNaN(cdId)) return res.status(400).json({ error: 'ID inválido' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  try {
    const { updateCountdown: update, getCountdown: get } = require('../db/database');
    const old = get(cdId);
    if (old && old.logo_path) {
      const oldFull = path.join(cdUploadsDir, old.logo_path);
      if (fs.existsSync(oldFull)) try { fs.unlinkSync(oldFull); } catch (_) {}
    }
    update(cdId, { logo_path: req.file.filename });
    res.json({ success: true, logoPath: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HORARIO DE LA TERRAZA ────────────────────────────────────────────────────

// GET /api/admin/terraza-hours (ADMIN ONLY)
router.get('/terraza-hours', requireAuth, (req, res) => {
  try {
    res.json(require('../services/terraza').getTerrazaHours());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/terraza-hours (ADMIN ONLY)
router.post('/terraza-hours', requireAuth, (req, res) => {
  try {
    const saved = require('../services/terraza').saveTerrazaHours(
      { days: req.body.days, overrides: req.body.overrides, note: req.body.note }, 'admin'
    );
    res.json({ success: true, ...saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── MEDIDOR DE AMBIENTE (FOMO) ───────────────────────────────────────────────

// GET /api/admin/vibe-tiers (ADMIN ONLY) — config + estado en vivo (con cifra exacta)
router.get('/vibe-tiers', requireAuth, (req, res) => {
  try {
    const vibe = require('../services/vibe');
    const { getEligibleRaffleParticipants } = require('../db/database');
    res.json({
      ...vibe.getVibeConfig(),
      live: { ...vibe.getVibeNow(), count: getEligibleRaffleParticipants().length }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/vibe-tiers (ADMIN ONLY) — guardar tramos editados
router.post('/vibe-tiers', requireAuth, (req, res) => {
  try {
    const saved = require('../services/vibe').saveVibeConfig({ enabled: req.body.enabled, tiers: req.body.tiers });
    res.json({ success: true, ...saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/admin/countdowns/:id (ADMIN ONLY)
router.delete('/countdowns/:id', requireAuth, (req, res) => {
  const cdId = parseInt(req.params.id);
  if (isNaN(cdId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { deleteCountdown: del, getCountdown: get } = require('../db/database');
    const old = get(cdId);
    if (old && old.logo_path) {
      const oldFull = path.join(cdUploadsDir, old.logo_path);
      if (fs.existsSync(oldFull)) try { fs.unlinkSync(oldFull); } catch (_) {}
    }
    del(cdId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// GET /api/admin/referral/stats (ADMIN ONLY)
router.get('/referral/stats', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const stats = db.prepare(`
      WITH friend_visits AS (
        SELECT DISTINCT wallet_address FROM visits
        UNION
        SELECT DISTINCT wallet_address FROM sessions WHERE counted_as_visit = 1
      ),
      referrer_stats AS (
        SELECT 
          r.referrer_wallet,
          COUNT(r.referred_wallet) as total_referred,
          SUM(CASE WHEN fv.wallet_address IS NOT NULL THEN 1 ELSE 0 END) as active_referred
        FROM referrals r
        LEFT JOIN friend_visits fv ON LOWER(r.referred_wallet) = LOWER(fv.wallet_address)
        GROUP BY r.referrer_wallet
      )
      SELECT 
        rs.referrer_wallet,
        rs.total_referred,
        rs.active_referred,
        (SELECT COUNT(*) FROM daily_tapa_claims dtc WHERE LOWER(dtc.wallet_address) = LOWER(rs.referrer_wallet) AND dtc.nft_type = 'referral') as total_claimed
      FROM referrer_stats rs
      ORDER BY rs.active_referred DESC, rs.total_referred DESC
    `).all();

    const details = stats.map(s => {
      const friends = db.prepare(`
        WITH friend_visits_count AS (
          SELECT LOWER(wallet_address) as wallet_address, COUNT(*) as visit_count
          FROM (
            SELECT LOWER(wallet_address) as wallet_address FROM visits
            UNION ALL
            SELECT LOWER(wallet_address) as wallet_address FROM sessions WHERE counted_as_visit = 1
          )
          GROUP BY wallet_address
        )
        SELECT 
          r.referred_wallet,
          r.created_at,
          COALESCE(fv.visit_count, 0) as visit_count
        FROM referrals r
        LEFT JOIN friend_visits_count fv ON LOWER(fv.wallet_address) = LOWER(r.referred_wallet)
        WHERE LOWER(r.referrer_wallet) = LOWER(?)
        ORDER BY visit_count DESC, r.created_at DESC
      `).all(s.referrer_wallet);

      return {
        ...s,
        friends
      };
    });

    res.json({ success: true, stats: details });
  } catch (e) {
    console.error('Error fetching referral stats:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BANCO DO CORCHO ($CORCHO) ────────────────────────────────────────────────

// GET /api/admin/corcho/stats — ajustes de economía, totales globales y ranking de holders
router.get('/corcho/stats', requireAuth, (req, res) => {
  try {
    const corcho = require('../services/corcho');
    const { db } = require('../db/database');
    const settings = corcho.getEconomySettings();

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(balance), 0) as total_circulating,
        COALESCE(SUM(total_earned), 0) as total_issued,
        COALESCE(SUM(total_spent), 0) as total_burned
      FROM corcho_balances
    `).get();

    const holders = db.prepare(`
      SELECT wallet_address, balance, total_earned, total_spent
      FROM corcho_balances
      ORDER BY balance DESC LIMIT 15
    `).all();

    const recentTx = db.prepare(`
      SELECT id, wallet_address, amount, type, description, created_at
      FROM corcho_transactions
      ORDER BY id DESC LIMIT 20
    `).all();

    res.json({
      settings,
      totals,
      holders,
      recentTx
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/corcho/settings — actualizar tarifas y recompensas de $CORCHO
router.post('/corcho/settings', requireAuth, (req, res) => {
  try {
    const corcho = require('../services/corcho');
    const updated = corcho.saveEconomySettings(req.body || {});
    res.json({ success: true, message: 'Tarifas del Banco do Corcho actualizadas', settings: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/corcho/grant — recargar o ajustar monedas manualmente a un usuario
router.post('/corcho/grant', requireAuth, (req, res) => {
  const { walletAddress, amount, description } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }
  const qty = parseInt(amount, 10);
  if (!qty || isNaN(qty)) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }

  try {
    const corcho = require('../services/corcho');
    let result;
    if (qty > 0) {
      result = corcho.addCorchoCoins(walletAddress, qty, 'admin_adjustment', description || 'Ajuste manual del administrador', `admin_${Date.now()}`);
    } else {
      result = corcho.spendCorchoCoins(walletAddress, Math.abs(qty), 'admin_adjustment', description || 'Ajuste manual del administrador', `admin_${Date.now()}`);
    }

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, message: `Ajuste de ${qty} $CORCHO realizado con éxito.`, newBalance: result.newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


