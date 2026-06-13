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
  getEligibleRaffleParticipants
} = require('../db/database');
const { DEMO_MODE } = require('../services/polygon');
const { sendPushToAll, sendPushToWallet, sendPushToWallets } = require('../services/push');

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
    const messages = db.prepare(`
      SELECT id, subject, body, sent_at, rsvp_event_id FROM messages
      WHERE level_filter = 'all' OR level_filter = ?
        OR (LOWER(level_filter) = LOWER(?) AND ? != '')
        OR (level_filter = 'checkedin' AND ?)
      ORDER BY sent_at DESC LIMIT 30
    `).all(level.toString(), verifiedWallet, verifiedWallet, isCheckedIn ? 1 : 0);
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
  const { subject, body, levelFilter, rsvpEventId } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Asunto y cuerpo son obligatorios' });
  }

  // Evento al que se adjunta el botón "¿te apetece?" (opcional). null = mensaje normal sin botón.
  const rsvpEvent = rsvpEventId != null && rsvpEventId !== '' && !isNaN(parseInt(rsvpEventId))
    ? parseInt(rsvpEventId) : null;

  // 'checkedin' = solo clientes que ficharon entrada esta noche dentro de la ventana del evento
  const checkedInOnly = levelFilter === 'checkedin';
  const wallets = checkedInOnly ? getEligibleRaffleParticipants() : getWalletsByLevel(levelFilter);

  // Guardar mensaje en DB
  const messageId = insertMessage({
    subject,
    body,
    levelFilter: levelFilter || 'all',
    recipientCount: wallets.length,
    rsvpEventId: rsvpEvent
  });

  console.log(`[MESSAGE] Mensaje publicado. Destinatarios estimados: ${wallets.length}${checkedInOnly ? ' (solo fichados en local)' : ''}`);

  // Push a móviles con pantalla apagada
  if (checkedInOnly) {
    sendPushToWallets(wallets, `📢 ${subject}`, body, { url: '/claim' });
  } else if (levelFilter && levelFilter.startsWith('0x')) {
    sendPushToWallet(levelFilter, `✉️ Mensaje privado: ${subject}`, body, { url: '/claim' });
  } else {
    sendPushToAll(`📢 ${subject}`, body, { url: '/claim' });
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
        FROM sessions
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

    const funnel = [
      { level: 1, name: 'Nv1 — Cautivo', count: nv1, pct_prev: 100 },
      { level: 2, name: 'Nv2 — Cunqueiro', count: nv2, pct_prev: nv1 > 0 ? Math.round(nv2 / nv1 * 100) : 0 },
      { level: 3, name: 'Nv3 — Larpeiro', count: nv3, pct_prev: nv2 > 0 ? Math.round(nv3 / nv2 * 100) : 0 },
      { level: 4, name: 'Nv4 — Presidente', count: nv4, pct_prev: nv3 > 0 ? Math.round(nv4 / nv3 * 100) : 0 }
    ];

    const noshow = db.prepare(`
      SELECT e.event_date, e.title,
        (SELECT COUNT(*) FROM rsvps WHERE event_id=e.id) as rsvp_count,
        (SELECT COUNT(DISTINCT LOWER(r.wallet_address)) 
         FROM rsvps r 
         JOIN sessions s ON LOWER(r.wallet_address) = LOWER(s.wallet_address)
         WHERE r.event_id = e.id 
           AND (date(s.entry_time) = e.event_date OR date(s.entry_time) = date(e.event_date, '+1 day'))
        ) as actual_count
      FROM events e WHERE e.active=1 ORDER BY e.event_date DESC LIMIT 6
    `).all();

    const newByEvent = db.prepare(`
      SELECT join_date as event_date, COUNT(*) as new_clients
      FROM (
        SELECT wallet, date(MIN(first_time)) as join_date
        FROM (
          SELECT LOWER(wallet_address) as wallet, MIN(entry_time) as first_time FROM sessions GROUP BY LOWER(wallet_address)
          UNION ALL
          SELECT LOWER(wallet_address) as wallet, MIN(minted_at) as first_time FROM mints WHERE status != 'failed' GROUP BY LOWER(wallet_address)
        ) GROUP BY wallet
      )
      GROUP BY join_date
      HAVING join_date IN (SELECT event_date FROM events)
      ORDER BY join_date DESC LIMIT 6
    `).all();

    const gapRow = db.prepare(`
      WITH unique_visits AS (
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date
        FROM sessions
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

    const retornoRow = db.prepare(`
      WITH unique_visits AS (
        SELECT DISTINCT LOWER(wallet_address) as wallet_address, date(entry_time) as visit_date
        FROM sessions
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
      SELECT
        COUNT(*) as total_with_2plus,
        COUNT(CASE WHEN gap <= 30 THEN 1 END) as returned_30d
      FROM gaps
    `).get();

    const total2plus = retornoRow?.total_with_2plus || 0;
    const returned_30d = retornoRow?.returned_30d || 0;
    const retorno_30d_pct = total2plus > 0 ? Math.round(returned_30d / total2plus * 100) : 0;

    res.json({
      funnel,
      noshow,
      newByEvent,
      avg_gap: gapRow?.avg_gap ? Math.round(gapRow.avg_gap) : null,
      retorno_30d_pct,
      returned_30d,
      total_with_2plus: total2plus
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
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
        MIN(entry_time) as primera_visita,
        (SELECT SUM(p.points) FROM points p WHERE LOWER(p.wallet_address)=LOWER(s.wallet_address)) as puntos
      FROM sessions s WHERE counted_as_visit=1
      GROUP BY LOWER(wallet_address)
      HAVING julianday('now') - julianday(MIN(entry_time)) < 45
      ORDER BY primera_visita DESC
    `).all();

    const habituales = db.prepare(`
      SELECT substr(s.wallet_address,1,6)||'...'||substr(s.wallet_address,-4) as wallet_masked,
        COUNT(*) as total_visits,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=LOWER(s.wallet_address) AND m.status='success') as nivel,
        (SELECT SUM(p.points) FROM points p WHERE LOWER(p.wallet_address)=LOWER(s.wallet_address)) as puntos
      FROM sessions s WHERE counted_as_visit=1
      GROUP BY LOWER(s.wallet_address) HAVING COUNT(*) >= 3
      ORDER BY total_visits DESC
    `).all();

    const vip_candidatos = db.prepare(`
      SELECT substr(s.wallet_address,1,6)||'...'||substr(s.wallet_address,-4) as wallet_masked,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=LOWER(s.wallet_address) AND m.status='success') as nivel,
        COUNT(*) as visitas,
        MAX(entry_time) as ultima_visita
      FROM sessions s WHERE counted_as_visit=1
      GROUP BY LOWER(s.wallet_address)
      HAVING COUNT(*) >= 2 AND (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=LOWER(s.wallet_address) AND m.status='success') >= 2
      ORDER BY (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=LOWER(s.wallet_address) AND m.status='success') DESC, COUNT(*) DESC
    `).all();

    const inactivos = db.prepare(`
      SELECT substr(s.wallet_address,1,6)||'...'||substr(s.wallet_address,-4) as wallet_masked,
        CAST(julianday('now') - julianday(MAX(entry_time)) AS INTEGER) as dias_sin_visita,
        (SELECT MAX(m.level) FROM mints m WHERE LOWER(m.wallet_address)=LOWER(s.wallet_address) AND m.status='success') as nivel,
        COUNT(*) as total_visits
      FROM sessions s WHERE counted_as_visit=1
      GROUP BY LOWER(s.wallet_address)
      HAVING CAST(julianday('now') - julianday(MAX(entry_time)) AS INTEGER) > 45 AND COUNT(*) >= 1
      ORDER BY dias_sin_visita DESC
    `).all();

    res.json({
      nuevos,
      habituales,
      vip_candidatos,
      inactivos,
      counts: {
        nuevos_count: nuevos.length,
        habituales_count: habituales.length,
        vip_count: vip_candidatos.length,
        inactivos_count: inactivos.length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/hourly?date=YYYY-MM-DD — Aforo por hora
router.get('/hourly', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    const date = req.query.date || '';
    if (!date) return res.status(400).json({ error: 'Falta date' });
    // Validar formato estricto YYYY-MM-DD (previene SQL injection)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Formato de fecha no válido' });
    const safeDate = date;

    const TZ = `'+2 hours'`;

    const entries_by_hour = db.prepare(`
      SELECT CAST(strftime('%H', entry_time, ${TZ}) AS INTEGER) as hour, COUNT(*) as count
      FROM sessions WHERE date(entry_time, ${TZ}) = ?
      GROUP BY hour ORDER BY hour
    `).all(safeDate);

    const exits_by_hour = db.prepare(`
      SELECT CAST(strftime('%H', exit_time, ${TZ}) AS INTEGER) as hour, COUNT(*) as count
      FROM sessions WHERE exit_time IS NOT NULL AND date(exit_time, ${TZ}) = ?
      GROUP BY hour ORDER BY hour
    `).all(safeDate);

    const inside_by_hour = [];
    for (let h = 16; h <= 23; h++) {
      const row = db.prepare(`
        SELECT COUNT(*) as count FROM sessions
        WHERE date(entry_time, ${TZ}) = ?
          AND CAST(strftime('%H', entry_time, ${TZ}) AS INTEGER) <= ${h}
          AND (exit_time IS NULL OR CAST(strftime('%H', exit_time, ${TZ}) AS INTEGER) > ${h})
      `).get(safeDate);
      inside_by_hour.push({ hour: h, count: row?.count || 0 });
    }

    const max_inside = Math.max(...inside_by_hour.map(x => x.count), 0);

    const durRow = db.prepare(`
      SELECT ROUND(AVG(duration_minutes), 0) as avg_duration
      FROM sessions
      WHERE exit_time IS NOT NULL AND duration_minutes > 0 AND duration_minutes < 300
        AND date(entry_time, ${TZ}) = ?
    `).get(safeDate);

    const peakEntry = entries_by_hour.reduce((a, b) => b.count > (a?.count || 0) ? b : a, null);
    const total_entries = entries_by_hour.reduce((s, r) => s + r.count, 0);

    const raffle_hours = db.prepare(`
      SELECT DISTINCT CAST(strftime('%H', created_at, ${TZ}) AS INTEGER) as hour
      FROM raffles WHERE date(created_at, ${TZ}) = ?
      ORDER BY hour
    `).all(safeDate);

    res.json({
      date,
      entries_by_hour,
      exits_by_hour,
      inside_by_hour,
      avg_duration: durRow?.avg_duration || null,
      max_inside,
      peak_hour: peakEntry?.hour || null,
      total_entries,
      raffle_hours
    });
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

    const levelRows = db.prepare(`SELECT level, COUNT(DISTINCT LOWER(wallet_address)) as count FROM mints WHERE status='success' GROUP BY level`).all();
    const levelMap = {};
    levelRows.forEach(r => { levelMap[r.level] = r.count; });
    const nv1 = levelMap[1] || 0, nv2 = levelMap[2] || 0, nv3 = levelMap[3] || 0, nv4 = levelMap[4] || 0;

    const noshow = db.prepare(`
      SELECT e.event_date, e.title,
        (SELECT COUNT(*) FROM rsvps WHERE event_id=e.id) as rsvp_count,
        (SELECT COUNT(DISTINCT LOWER(r.wallet_address)) 
         FROM rsvps r 
         JOIN sessions s ON LOWER(r.wallet_address) = LOWER(s.wallet_address)
         WHERE r.event_id = e.id 
           AND (date(s.entry_time) = e.event_date OR date(s.entry_time) = date(e.event_date, '+1 day'))
        ) as actual_count
      FROM events e WHERE e.active=1 ORDER BY e.event_date DESC LIMIT 6
    `).all();

    const topPoints = db.prepare(`
      SELECT wallet_address, substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked, SUM(points) as total_points
      FROM points GROUP BY LOWER(wallet_address) ORDER BY total_points DESC LIMIT 8
    `).all();

    const segCounts = {
      nuevos_count: db.prepare(`SELECT COUNT(DISTINCT LOWER(wallet_address)) as c FROM sessions WHERE counted_as_visit=1 GROUP BY LOWER(wallet_address) HAVING julianday('now') - julianday(MIN(entry_time)) < 45`).all().length,
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
    const { db, getVisitCount } = require('../db/database');
    
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

    res.json({
      walletAddress: address,
      level,
      levelName,
      visitCount,
      lastVisit: lastSession ? lastSession.entry_time : (holder ? holder.minted_at : null),
      activeNow: !!activeSession,
      activeSessionStart: activeSession ? activeSession.entry_time : null,
      tapasByDay
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

// GET /api/admin/pending-mints — lista de NFTs esperando aprobación
router.get('/pending-mints', requireAuth, (_req, res) => {
  try {
    const mints = getPendingApprovalMints().map(m => ({
      ...m,
      wallet_masked: `${m.wallet_address.slice(0, 6)}...${m.wallet_address.slice(-4)}`,
      visit_count: getVisitCount(m.wallet_address)
    }));
    res.json(mints);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mints/:id/approve — aprueba el mint y lo manda a la cola blockchain
router.post('/mints/:id/approve', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    approveMint(id);
    const { notifyQueue } = require('../services/polygon');
    notifyQueue();
    res.json({ success: true, message: '¡Aprobado! El NFT entrará en la cola de Polygon ahora mismo.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mints/:id/reject — rechaza el mint (no se mintea nada)
router.post('/mints/:id/reject', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    rejectMint(id);
    res.json({ success: true, message: 'Mint rechazado correctamente.' });
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


module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.verifyAdminToken = verifyToken;
