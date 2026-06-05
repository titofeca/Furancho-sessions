// Usa el SQLite nativo de Node.js (v22+) — sin dependencias externas ni compilación
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'furancho.db');
const db = new DatabaseSync(DB_PATH);

// Activar WAL mode y foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Migraciones seguras
try { db.exec(`ALTER TABLE events ADD COLUMN vip_max INTEGER DEFAULT 15`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_by TEXT`); } catch (_) {}
// Limpiar reservas VIP huérfanas (apuntan a eventos que ya no existen)
try {
  db.exec(`DELETE FROM vip_reservations WHERE event_id NOT IN (SELECT id FROM events)`);
} catch (_) {}

// =====================
// CREAR TABLAS
// =====================
db.exec(`
  CREATE TABLE IF NOT EXISTS mints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    wallet_address TEXT NOT NULL,
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
    level_name TEXT NOT NULL,
    crossmint_action_id TEXT,
    status TEXT DEFAULT 'pending',
    event_date TEXT DEFAULT (date('now')),
    minted_at TEXT DEFAULT (datetime('now')),
    ip_address TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    level_filter TEXT DEFAULT 'all',
    recipient_count INTEGER DEFAULT 0,
    sent_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize TEXT NOT NULL,
    winner_wallet TEXT,
    verification_code TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mints_level ON mints(level);
  CREATE INDEX IF NOT EXISTS idx_mints_wallet ON mints(wallet_address);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mints_wallet_level ON mints(wallet_address, level);

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    email TEXT,
    ip_address TEXT,
    visited_at TEXT DEFAULT (datetime('now')),
    event_date TEXT DEFAULT (date('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_visits_wallet ON visits(wallet_address);

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    entry_time TEXT DEFAULT (datetime('now')),
    exit_time TEXT,
    duration_minutes INTEGER,
    counted_as_visit INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet_address);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL UNIQUE,
    title TEXT DEFAULT 'Furancho Sessions',
    description TEXT,
    active INTEGER DEFAULT 1,
    vip_max INTEGER DEFAULT 15
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(event_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS vip_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    phone TEXT NOT NULL,
    group_size INTEGER NOT NULL CHECK(group_size >= 4 AND group_size <= 15),
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(event_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    wallet_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Sesiones de prueba del 4 jun antes de las 19:30 no cuentan como visita real
try {
  db.exec(`
    UPDATE sessions SET counted_as_visit = 0
    WHERE date(entry_time) = '2026-06-04'
      AND time(entry_time) < '19:30:00'
      AND counted_as_visit = 1
  `);
} catch (_) {}

// =====================
// HELPERS
// =====================

function insertMint({ email, level, levelName, walletAddress, crossmintActionId, status, ipAddress }) {
  const stmt = db.prepare(`
    INSERT INTO mints (email, level, level_name, wallet_address, crossmint_action_id, status, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(email || null, level, levelName, walletAddress, crossmintActionId || null, status || 'pending', ipAddress || null);
  return result.lastInsertRowid;
}

function updateMintStatus(id, status, walletAddress) {
  db.prepare(`UPDATE mints SET status = ?, wallet_address = ? WHERE id = ?`).run(status, walletAddress, id);
}

function insertVisit(walletAddress, email, ipAddress) {
  const stmt = db.prepare(`
    INSERT INTO visits (wallet_address, email, ip_address)
    VALUES (?, ?, ?)
  `);
  stmt.run(walletAddress, email || null, ipAddress || null);
}



function checkRecentVisit(walletAddress, hours = 12) {
  const row = db.prepare(`
    SELECT visited_at 
    FROM visits 
    WHERE wallet_address = ? 
      AND visited_at >= datetime('now', '-${hours} hours')
    ORDER BY visited_at DESC 
    LIMIT 1
  `).get(walletAddress);
  const row2 = db.prepare(`
    SELECT exit_time
    FROM sessions
    WHERE wallet_address = ? 
      AND exit_time >= datetime('now', '-${hours} hours')
      AND counted_as_visit = 1
    ORDER BY exit_time DESC 
    LIMIT 1
  `).get(walletAddress);
  return !!row || !!row2;
}


function getVisitCount(walletAddress) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE wallet_address = ?`).get(walletAddress);
  const row2 = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE wallet_address = ? AND counted_as_visit = 1`).get(walletAddress);
  return (row ? row.count : 0) + (row2 ? row2.count : 0);
}

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as count FROM mints WHERE status != 'failed'`).get();
  const byLevel = db.prepare(`
    SELECT level, level_name, COUNT(*) as count
    FROM mints WHERE status != 'failed'
    GROUP BY level ORDER BY level
  `).all();
  const recent = db.prepare(`
    SELECT level, level_name,
           substr(wallet_address, 1, 6) || '...' || substr(wallet_address, -6) as wallet_masked,
           minted_at, status
    FROM mints ORDER BY minted_at DESC LIMIT 20
  `).all();
  const byDate = db.prepare(`
    SELECT event_date, COUNT(*) as count
    FROM mints WHERE status != 'failed'
    GROUP BY event_date ORDER BY event_date DESC LIMIT 30
  `).all();

  const totalVisitsRow = db.prepare(`SELECT COUNT(*) as count FROM visits`).get();
  const totalSessionsRow = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE counted_as_visit = 1`).get();
  const totalVisits = (totalVisitsRow ? totalVisitsRow.count : 0) + (totalSessionsRow ? totalSessionsRow.count : 0);

  return { total: total.count, byLevel, recent, byDate, totalVisits };
}

function getHolders(levelFilter) {
  if (levelFilter && levelFilter !== 'all') {
    return db.prepare(`
      SELECT id,
        substr(wallet_address, 1, 6) || '...' || substr(wallet_address, -6) as wallet_masked,
        wallet_address, level, level_name, minted_at, event_date, status
      FROM mints
      WHERE status != 'failed' AND level = ?
      ORDER BY minted_at DESC
    `).all(parseInt(levelFilter));
  }
  return db.prepare(`
    SELECT id,
      substr(wallet_address, 1, 6) || '...' || substr(wallet_address, -6) as wallet_masked,
      wallet_address, level, level_name, minted_at, event_date, status
    FROM mints
    WHERE status != 'failed'
    ORDER BY minted_at DESC
  `).all();
}

function getMultiLevelHolders() {
  return db.prepare(`
    SELECT wallet_address,
           COUNT(DISTINCT level) as levels_count,
           GROUP_CONCAT(DISTINCT level_name) as levels,
           MIN(minted_at) as first_visit,
           MAX(minted_at) as last_visit,
           COUNT(*) as total_visits
    FROM mints WHERE status != 'failed'
    GROUP BY wallet_address
    HAVING levels_count > 1
    ORDER BY levels_count DESC, total_visits DESC
  `).all();
}

function getWalletsByLevel(levelFilter) {
  if (levelFilter && levelFilter !== 'all') {
    return db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE status != 'failed' AND level = ?`)
      .all(parseInt(levelFilter))
      .map(r => r.wallet_address);
  }
  return db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE status != 'failed'`)
    .all()
    .map(r => r.wallet_address);
}

function insertMessage({ subject, body, levelFilter, recipientCount }) {
  const stmt = db.prepare(`
    INSERT INTO messages (subject, body, level_filter, recipient_count)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(subject, body, levelFilter, recipientCount).lastInsertRowid;
}

function getMessages() {
  return db.prepare(`SELECT * FROM messages ORDER BY sent_at DESC LIMIT 50`).all();
}

function getClaimedLevels(walletAddress) {
  return db.prepare(`
    SELECT level FROM mints 
    WHERE wallet_address = ? AND status = 'success'
  `).all(walletAddress).map(r => r.level);
}

function checkDuplicate(walletAddress, email, level) {
  let row;
  if (email) {
    row = db.prepare(`
      SELECT id FROM mints 
      WHERE (wallet_address = ? OR email = ?) AND level = ? AND status != 'failed'
    `).get(walletAddress, email.toLowerCase().trim(), level);
  } else {
    row = db.prepare(`
      SELECT id FROM mints 
      WHERE wallet_address = ? AND level = ? AND status != 'failed'
    `).get(walletAddress, level);
  }
  return !!row;
}


function openSession(walletAddress) {
  const openSession = db.prepare(`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1`).get(walletAddress);
  if (!openSession) {
    db.prepare(`INSERT INTO sessions (wallet_address) VALUES (?)`).run(walletAddress);
  }
}

function closeSession(walletAddress) {
  const session = db.prepare(`
    SELECT id, entry_time FROM sessions 
    WHERE wallet_address = ? AND exit_time IS NULL 
    ORDER BY entry_time DESC LIMIT 1
  `).get(walletAddress);

  if (session) {
    const entryDate = new Date(session.entry_time + 'Z');
    const now = new Date();
    let diffMinutes = Math.floor((now - entryDate) / 60000);
    // Asignar 60 min si pasaron mas de 12 horas o es negativo
    if (diffMinutes > 12 * 60 || diffMinutes < 0) {
      diffMinutes = 60;
    }
    db.prepare(`
      UPDATE sessions 
      SET exit_time = datetime('now'), duration_minutes = ?, counted_as_visit = 1 
      WHERE id = ?
    `).run(diffMinutes, session.id);
  } else {
    // Sesion huerfana: no escaneo a la entrada. Damos 60 min
    db.prepare(`
      INSERT INTO sessions (wallet_address, entry_time, exit_time, duration_minutes, counted_as_visit) 
      VALUES (?, datetime('now', '-60 minutes'), datetime('now'), 60, 1)
    `).run(walletAddress);
  }
}

function savePushSubscription(walletAddress, subscription) {
  db.prepare(`
    INSERT INTO push_subscriptions (wallet_address, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET wallet_address=excluded.wallet_address
  `).run(walletAddress || null, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
}

function getAllPushSubscriptions() {
  return db.prepare(`SELECT * FROM push_subscriptions`).all();
}

function deletePushSubscription(endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

function getEvents() {
  return db.prepare(`
    SELECT e.*, COUNT(r.id) as rsvp_count
    FROM events e LEFT JOIN rsvps r ON e.id = r.event_id
    WHERE e.active = 1
    GROUP BY e.id
    ORDER BY e.event_date ASC
  `).all();
}

function toggleRsvp(eventId, walletAddress) {
  const existing = db.prepare(`SELECT id FROM rsvps WHERE event_id=? AND wallet_address=?`).get(eventId, walletAddress);
  if (existing) {
    db.prepare(`DELETE FROM rsvps WHERE event_id=? AND wallet_address=?`).run(eventId, walletAddress);
    return false; // cancelado
  } else {
    db.prepare(`INSERT INTO rsvps (event_id, wallet_address) VALUES (?,?)`).run(eventId, walletAddress);
    return true; // apuntado
  }
}

function getRsvpStatus(walletAddress) {
  return db.prepare(`SELECT event_id FROM rsvps WHERE wallet_address=?`).all(walletAddress).map(r => r.event_id);
}

function createEvent({ date, title, description }) {
  return db.prepare(`
    INSERT INTO events (event_date, title, description)
    VALUES (?, ?, ?)
    ON CONFLICT(event_date) DO UPDATE SET title=excluded.title, description=excluded.description
  `).run(date, title || 'Furancho Sessions', description || null).lastInsertRowid;
}

function updateEvent(id, { title, description, date, active }) {
  const fields = [];
  const vals = [];
  if (title !== undefined)       { fields.push('title = ?');       vals.push(title); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
  if (date !== undefined)        { fields.push('event_date = ?');  vals.push(date); }
  if (active !== undefined)      { fields.push('active = ?');      vals.push(active ? 1 : 0); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteEvent(id) {
  db.prepare(`UPDATE events SET active = 0 WHERE id = ?`).run(id);
}

function getAllEvents() {
  return db.prepare(`
    SELECT e.*, COUNT(r.id) as rsvp_count
    FROM events e LEFT JOIN rsvps r ON e.id = r.event_id
    GROUP BY e.id
    ORDER BY e.event_date ASC
  `).all();
}

function seedEvents() {
  const dates = [
    { date: '2026-06-11', title: 'Furancho Sessions — 11 Junio', description: 'La primera. La que marca el ritmo. Vinos locales gallegos, tapas de autor y el ambiente que solo el Furancho sabe crear. Nos vemos el jueves.' },
    { date: '2026-06-18', title: 'Furancho Sessions — 18 Junio', description: 'Una cata selecta acompañada de las mejores tapas de temporada. Descubre nuevos sabores en un ambiente único y relajado entre amigos.' },
    { date: '2026-06-25', title: 'Furancho Sessions — 25 Junio', description: 'Especial Noche de San Juan. Fogata simbólica, música tradicional gallega y nuestro menú especial de tapas y vinos galardonados.' },
    { date: '2026-07-02', title: 'Furancho Sessions — 2 Julio', description: 'Algo está preparándose. No podemos decir mucho… solo que merece la pena estar. Apúntate y descúbrelo.' },
  ];
  // UPSERT: inserta si no existe, actualiza título/descripción si cambian
  // NUNCA borra — los IDs se mantienen estables entre reinicios para que las reservas no se huerfanen
  dates.forEach(({ date, title, description }) => {
    db.prepare(`
      INSERT INTO events (event_date, title, description) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO UPDATE SET title=excluded.title, description=excluded.description
    `).run(date, title, description);
  });
}
seedEvents();

function getVipCapacity(eventId) {
  const event = db.prepare(`SELECT vip_max FROM events WHERE id=?`).get(eventId);
  const max = event ? (event.vip_max ?? 15) : 15;
  const used = db.prepare(`
    SELECT COALESCE(SUM(group_size),0) as total
    FROM vip_reservations WHERE event_id=? AND status != 'cancelled'
  `).get(eventId);
  return { used: used.total, remaining: max - used.total, max };
}

function setVipMax(eventId, newMax) {
  if (newMax < 0) throw new Error('La capacidad no puede ser negativa.');
  db.prepare(`UPDATE events SET vip_max=? WHERE id=?`).run(newMax, eventId);
  return getVipCapacity(eventId);
}

function createVipReservation({ eventId, walletAddress, phone, groupSize, notes }) {
  const cap = getVipCapacity(eventId);
  if (groupSize < 4) throw new Error('El mínimo es 4 personas.');
  if (groupSize > cap.remaining) throw new Error(`Solo quedan ${cap.remaining} plazas VIP disponibles.`);
  const existing = db.prepare(`SELECT id FROM vip_reservations WHERE event_id=? AND wallet_address=?`).get(eventId, walletAddress);
  if (existing) throw new Error('Ya tienes una reserva para este evento.');
  db.prepare(`INSERT INTO vip_reservations (event_id, wallet_address, phone, group_size, notes) VALUES (?,?,?,?,?)`)
    .run(eventId, walletAddress, phone, groupSize, notes || null);
  return getVipCapacity(eventId);
}

function getVipReservations(eventId) {
  return db.prepare(`
    SELECT id, substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
           phone, group_size, status, notes, created_at
    FROM vip_reservations WHERE event_id=? ORDER BY created_at ASC
  `).all(eventId);
}

function getVipReservation(reservationId) {
  return db.prepare(`
    SELECT r.id, r.phone, r.group_size, r.status, r.notes, r.event_id,
           e.title as event_title, e.event_date
    FROM vip_reservations r JOIN events e ON r.event_id = e.id
    WHERE r.id=?
  `).get(reservationId);
}

function updateVipStatus(reservationId, status) {
  db.prepare(`UPDATE vip_reservations SET status=? WHERE id=?`).run(status, reservationId);
}

function getSessionAnalytics() {
  const avgByLevel = db.prepare(`
    SELECT m.level, m.level_name,
           ROUND(AVG(s.duration_minutes), 1) as avg_minutes,
           COUNT(DISTINCT s.wallet_address) as unique_clients,
           COUNT(s.id) as total_sessions
    FROM sessions s
    JOIN (SELECT wallet_address, MAX(level) as level, MAX(level_name) as level_name FROM mints WHERE status='success' GROUP BY wallet_address) m
      ON s.wallet_address = m.wallet_address
    WHERE s.exit_time IS NOT NULL AND s.duration_minutes > 0
    GROUP BY m.level ORDER BY m.level
  `).all();

  const topClients = db.prepare(`
    SELECT wallet_address,
           substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
           COUNT(*) as total_visits,
           ROUND(AVG(duration_minutes),1) as avg_stay,
           MAX(entry_time) as last_visit
    FROM sessions WHERE exit_time IS NOT NULL
    GROUP BY wallet_address ORDER BY total_visits DESC LIMIT 10
  `).all();

  const activeNow = db.prepare(`SELECT COUNT(DISTINCT wallet_address) as count FROM sessions WHERE exit_time IS NULL`).get();
  const avgGlobal = db.prepare(`SELECT ROUND(AVG(duration_minutes),1) as avg FROM sessions WHERE exit_time IS NOT NULL AND duration_minutes > 0 AND duration_minutes < 300`).get();

  return { avgByLevel, topClients, activeNow: activeNow.count, avgGlobal: avgGlobal.avg };
}

function getEligibleRaffleParticipants() {
  // Elegibles: ficharon entrada HOY y aún no salieron (o salida fue automática a las 23:00)
  // Si el sorteo es antes de las 23:00: sesión abierta HOY
  // Si el sorteo es después de las 23:00: sesión abierta HOY (ya cerrada automáticamente)
  const now = new Date();
  const cutoff = now.getHours() < 23 ? `exit_time IS NULL` : `date(exit_time) = date('now')`;
  return db.prepare(`
    SELECT DISTINCT wallet_address FROM sessions
    WHERE date(entry_time) = date('now') AND (${cutoff} OR exit_time IS NULL)
  `).all().map(r => r.wallet_address);
}

function autoCloseSessionsAt23() {
  // Cierra todas las sesiones abiertas del día actual a las 23:00 y las cuenta como visita
  const result = db.prepare(`
    UPDATE sessions
    SET exit_time = datetime('now'), duration_minutes =
      CASE WHEN (CAST((julianday('now') - julianday(entry_time)) * 1440 AS INTEGER)) > 720
        THEN 240
        ELSE CAST((julianday('now') - julianday(entry_time)) * 1440 AS INTEGER)
      END,
    counted_as_visit = 1
    WHERE exit_time IS NULL AND date(entry_time) = date('now')
  `).run();
  console.log(`[Auto-checkout 23:00] Sesiones cerradas: ${result.changes}`);
  return result.changes;
}

function insertRaffle(prize, winnerWallet, verificationCode) {
  return db.prepare(`
    INSERT INTO raffles (prize, winner_wallet, verification_code)
    VALUES (?, ?, ?)
  `).run(prize, winnerWallet, verificationCode).lastInsertRowid;
}

function collectRaffle(raffleId, adminNote) {
  db.prepare(`
    UPDATE raffles SET collected = 1, collected_at = datetime('now'), collected_by = ?
    WHERE id = ?
  `).run(adminNote || null, raffleId);
}

function getRaffleHistory() {
  return db.prepare(`
    SELECT id, prize,
           substr(winner_wallet,1,6)||'...'||substr(winner_wallet,-4) as wallet_masked,
           winner_wallet,
           verification_code, created_at,
           collected, collected_at, collected_by
    FROM raffles
    ORDER BY created_at DESC LIMIT 100
  `).all();
}

function getMyWins(walletAddress) {
  return db.prepare(`
    SELECT id, prize, verification_code, created_at, collected, collected_at
    FROM raffles WHERE winner_wallet = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(walletAddress);
}

const ALLOWED_REACTIONS = ['🍷', '🙌', '😂', '🔥'];

function addReaction(messageId, emoji, walletAddress) {
  if (!ALLOWED_REACTIONS.includes(emoji)) throw new Error('Emoji no permitido');
  // Si ya reaccionó, actualiza el emoji
  db.prepare(`
    INSERT INTO message_reactions (message_id, emoji, wallet_address)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id, wallet_address) DO UPDATE SET emoji = excluded.emoji
  `).run(messageId, emoji, walletAddress || null);
}

function getReactions(messageId) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) as count
    FROM message_reactions WHERE message_id = ?
    GROUP BY emoji
  `).all(messageId);
  const result = {};
  ALLOWED_REACTIONS.forEach(e => { result[e] = 0; });
  rows.forEach(r => { result[r.emoji] = r.count; });
  return result;
}

function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT message_id, emoji, COUNT(*) as count
    FROM message_reactions WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji
  `).all(...messageIds);
  const result = {};
  messageIds.forEach(id => {
    result[id] = {};
    ALLOWED_REACTIONS.forEach(e => { result[id][e] = 0; });
  });
  rows.forEach(r => { if (result[r.message_id]) result[r.message_id][r.emoji] = r.count; });
  return result;
}

function getEventSessions(dateFilter) {
  // dateFilter: 'YYYY-MM-DD' o null para hoy
  const day = dateFilter || new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT
      s.id,
      s.wallet_address,
      substr(s.wallet_address,1,6)||'...'||substr(s.wallet_address,-4) as wallet_masked,
      s.entry_time,
      s.exit_time,
      s.duration_minutes,
      s.counted_as_visit,
      COALESCE(m.level, 0) as level,
      COALESCE(m.level_name, 'Sin NFT') as level_name
    FROM sessions s
    LEFT JOIN (
      SELECT wallet_address, MAX(level) as level, MAX(level_name) as level_name
      FROM mints WHERE status='success' GROUP BY wallet_address
    ) m ON s.wallet_address = m.wallet_address
    WHERE date(s.entry_time) = ?
    ORDER BY s.entry_time DESC
  `).all(day);
}

function getSessionDates() {
  return db.prepare(`
    SELECT DISTINCT date(entry_time) as day, COUNT(*) as count
    FROM sessions WHERE entry_time IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();
}

module.exports = {
  openSession,
  closeSession,
  checkRecentVisit,
  db,
  insertMint,
  updateMintStatus,
  getStats,
  getHolders,
  getMultiLevelHolders,
  getWalletsByLevel,
  getClaimedLevels,
  insertMessage,
  getMessages,
  checkDuplicate,
  insertVisit,
  getVisitCount,
  getEligibleRaffleParticipants,
  autoCloseSessionsAt23,
  insertRaffle,
  collectRaffle,
  getRaffleHistory,
  getMyWins,
  getSessionAnalytics,
  getEventSessions,
  getSessionDates,
  createEvent,
  updateEvent,
  deleteEvent,
  getAllEvents,
  getEvents,
  toggleRsvp,
  getRsvpStatus,
  createVipReservation,
  getVipReservations,
  getVipReservation,
  getVipCapacity,
  setVipMax,
  updateVipStatus,
  savePushSubscription,
  getAllPushSubscriptions,
  deletePushSubscription,
  addReaction,
  getReactions,
  getReactionsForMessages,
  ALLOWED_REACTIONS
};
