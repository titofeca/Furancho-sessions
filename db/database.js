// Usa el SQLite nativo de Node.js (v22+) — sin dependencias externas ni compilación
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'furancho.db');
const db = new DatabaseSync(DB_PATH);

// Activar WAL mode, foreign keys y busy_timeout para tolerar bloqueos en rolling deploy
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Migraciones seguras
try { db.exec(`ALTER TABLE events ADD COLUMN vip_max INTEGER DEFAULT 15`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_by TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN status TEXT DEFAULT 'pending_acceptance'`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN acceptance_deadline TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN accepted_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN rejected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN rejection_note TEXT`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS prize_presets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS raffle_participants (raffle_id INTEGER NOT NULL, wallet_address TEXT NOT NULL, PRIMARY KEY (raffle_id, wallet_address))`); } catch (_) {}
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
    counted_as_visit INTEGER DEFAULT 0,
    exit_points INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet_address);

  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    points INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_points_wallet ON points(wallet_address);

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

// Migraciones seguras
try { db.exec(`ALTER TABLE sessions ADD COLUMN exit_points INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, points INTEGER NOT NULL, reason TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_points_wallet ON points(wallet_address)`); } catch (_) {}

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
  // Total: wallets únicas con mint O con sesión
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT wallet_address FROM mints WHERE status != 'failed'
      UNION
      SELECT wallet_address FROM sessions
    )
  `).get();

  // Nivel efectivo: mint confirma el nivel; sesión sin mint = Nv1 implícito
  const byLevel = db.prepare(`
    SELECT level, level_name, COUNT(*) as count FROM (
      SELECT wallet_address, MAX(level) as level, MAX(level_name) as level_name
      FROM mints WHERE status = 'success' GROUP BY wallet_address
      UNION ALL
      SELECT wallet_address, 1 as level, 'Cautivo' as level_name
      FROM sessions
      WHERE wallet_address NOT IN (SELECT wallet_address FROM mints WHERE status = 'success')
      GROUP BY wallet_address
    ) GROUP BY level ORDER BY level
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
  // Nv2-4: solo en mints (tienen NFT real o demo)
  // Nv1: sesiones sin mint asociado (escanaron entrada pero no salida/mint)
  // "all": unión de ambos grupos
  const lvl = levelFilter && levelFilter !== 'all' ? parseInt(levelFilter) : null;

  if (lvl && lvl >= 2) {
    return db.prepare(`
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-6) as wallet_masked,
             wallet_address, level, level_name, minted_at as event_date, status
      FROM mints WHERE status != 'failed' AND level = ?
      ORDER BY minted_at DESC
    `).all(lvl);
  }

  if (lvl === 1) {
    // Primero los que tienen mint Nv1, luego los que solo tienen sesión
    return db.prepare(`
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-6) as wallet_masked,
             wallet_address, 1 as level, 'Cautivo' as level_name,
             MAX(entry_time) as event_date, 'session' as status
      FROM sessions
      WHERE wallet_address NOT IN (SELECT wallet_address FROM mints WHERE status='success')
      GROUP BY wallet_address
      UNION ALL
      SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-6) as wallet_masked,
             wallet_address, level, level_name, minted_at as event_date, status
      FROM mints WHERE status != 'failed' AND level = 1
      ORDER BY event_date DESC
    `).all();
  }

  // All: union de sesiones-sin-mint (Nv1 implícito) + todos los mints
  return db.prepare(`
    SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-6) as wallet_masked,
           wallet_address, 1 as level, 'Cautivo' as level_name,
           MAX(entry_time) as event_date, 'session' as status
    FROM sessions
    WHERE wallet_address NOT IN (SELECT wallet_address FROM mints WHERE status='success')
    GROUP BY wallet_address
    UNION ALL
    SELECT substr(wallet_address,1,6)||'...'||substr(wallet_address,-6) as wallet_masked,
           wallet_address, level, level_name, minted_at as event_date, status
    FROM mints WHERE status != 'failed'
    ORDER BY event_date DESC
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

// manual=true → escaneó QR salida (80pts), manual=false → cierre automático (5pts)
function closeSession(walletAddress, manual = true) {
  const pts = manual ? 80 : 5;
  const reason = manual ? 'Salida fichada' : 'Salida automática';

  const session = db.prepare(`
    SELECT id, entry_time FROM sessions
    WHERE wallet_address = ? AND exit_time IS NULL
    ORDER BY entry_time DESC LIMIT 1
  `).get(walletAddress);

  if (session) {
    const entryDate = new Date(session.entry_time + 'Z');
    const now = new Date();
    let diffMinutes = Math.floor((now - entryDate) / 60000);
    if (diffMinutes > 12 * 60 || diffMinutes < 0) diffMinutes = 60;
    db.prepare(`
      UPDATE sessions
      SET exit_time = datetime('now'), duration_minutes = ?, counted_as_visit = 1, exit_points = ?
      WHERE id = ?
    `).run(diffMinutes, pts, session.id);
  } else {
    db.prepare(`
      INSERT INTO sessions (wallet_address, entry_time, exit_time, duration_minutes, counted_as_visit, exit_points)
      VALUES (?, datetime('now', '-60 minutes'), datetime('now'), 60, 1, ?)
    `).run(walletAddress, pts);
  }

  // Registrar puntos
  db.prepare(`INSERT INTO points (wallet_address, points, reason) VALUES (?, ?, ?)`).run(walletAddress, pts, reason);
}

function getPoints(walletAddress) {
  const row = db.prepare(`SELECT COALESCE(SUM(points),0) as total FROM points WHERE wallet_address = ?`).get(walletAddress);
  return row ? row.total : 0;
}

function getPointsHistory(walletAddress) {
  return db.prepare(`SELECT points, reason, created_at FROM points WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 20`).all(walletAddress);
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
try { seedEvents(); } catch(e) { console.warn('[DB] seedEvents falló (posible lock en deploy):', e.message); }

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
  // Cierra todas las sesiones abiertas y asigna 5 puntos (salida automática)
  const open = db.prepare(`SELECT id, wallet_address FROM sessions WHERE exit_time IS NULL AND date(entry_time) = date('now')`).all();
  const stmt = db.prepare(`
    UPDATE sessions
    SET exit_time = datetime('now'),
        duration_minutes = CASE WHEN (CAST((julianday('now') - julianday(entry_time)) * 1440 AS INTEGER)) > 720
          THEN 240
          ELSE CAST((julianday('now') - julianday(entry_time)) * 1440 AS INTEGER) END,
        counted_as_visit = 1,
        exit_points = 5
    WHERE id = ?
  `);
  const pts = db.prepare(`INSERT INTO points (wallet_address, points, reason) VALUES (?, 5, 'Salida automática')`);
  open.forEach(s => { stmt.run(s.id); pts.run(s.wallet_address); });
  console.log(`[Auto-checkout 23:00] Sesiones cerradas: ${open.length}`);
  return open.length;
}

function insertRaffle(prize, winnerWallet, verificationCode, participantWallets = []) {
  const deadline = new Date(Date.now() + 90000).toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(`
    INSERT INTO raffles (prize, winner_wallet, verification_code, status, acceptance_deadline)
    VALUES (?, ?, ?, 'pending_acceptance', ?)
  `).run(prize, winnerWallet, verificationCode, deadline).lastInsertRowid;
  if (participantWallets.length) {
    const stmt = db.prepare(`INSERT OR IGNORE INTO raffle_participants (raffle_id, wallet_address) VALUES (?, ?)`);
    participantWallets.forEach(w => stmt.run(id, w));
  }
  return id;
}

function acceptRaffle(raffleId, walletAddress) {
  const raffle = db.prepare(`SELECT winner_wallet, status FROM raffles WHERE id = ?`).get(raffleId);
  if (!raffle) throw new Error('Sorteo no encontrado');
  if (raffle.winner_wallet !== walletAddress) throw new Error('No eres el ganador');
  if (raffle.status !== 'pending_acceptance') throw new Error('Este sorteo ya no está activo');
  db.prepare(`UPDATE raffles SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?`).run(raffleId);
}

function rejectRaffle(raffleId, note) {
  db.prepare(`UPDATE raffles SET status = 'rejected', rejected_at = datetime('now'), rejection_note = ? WHERE id = ?`)
    .run(note || null, raffleId);
}

function collectRaffle(raffleId, adminNote) {
  db.prepare(`
    UPDATE raffles SET collected = 1, status = 'collected', collected_at = datetime('now'), collected_by = ?
    WHERE id = ?
  `).run(adminNote || null, raffleId);
}

function getRaffleHistory() {
  return db.prepare(`
    SELECT id, prize,
           substr(winner_wallet,1,6)||'...'||substr(winner_wallet,-4) as wallet_masked,
           winner_wallet, verification_code, created_at,
           collected, collected_at, collected_by, status, rejection_note, accepted_at
    FROM raffles
    ORDER BY created_at DESC LIMIT 100
  `).all();
}

function getMyWins(walletAddress) {
  return db.prepare(`
    SELECT id, prize, verification_code, created_at, collected, collected_at
    FROM raffles WHERE winner_wallet = ? AND status IN ('accepted','collected')
    ORDER BY created_at DESC LIMIT 20
  `).all(walletAddress);
}

function getRaffleParticipation(walletAddress) {
  return db.prepare(`
    SELECT r.id, r.prize, r.status, r.created_at, r.collected, r.collected_at, r.rejection_note,
           CASE WHEN r.winner_wallet = ? THEN 1 ELSE 0 END as is_winner,
           CASE WHEN r.winner_wallet = ? THEN r.verification_code ELSE NULL END as verification_code
    FROM raffles r
    WHERE r.id IN (SELECT raffle_id FROM raffle_participants WHERE wallet_address = ?)
       OR r.winner_wallet = ?
    ORDER BY r.created_at DESC LIMIT 30
  `).all(walletAddress, walletAddress, walletAddress, walletAddress);
}

function getPrizePresets() {
  return db.prepare(`SELECT id, name FROM prize_presets WHERE active = 1 ORDER BY created_at ASC`).all();
}

function addPrizePreset(name) {
  return db.prepare(`INSERT INTO prize_presets (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active=1`).run(name).lastInsertRowid;
}

function deletePrizePreset(id) {
  db.prepare(`UPDATE prize_presets SET active = 0 WHERE id = ?`).run(id);
}

function getRaffleCountTonight() {
  return db.prepare(`SELECT COUNT(*) as count FROM raffles WHERE date(created_at) = date('now')`).get()?.count || 0;
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
  // Para el 4 jun excluir scans de prueba (antes de 19:30 CEST = 17:30 UTC)
  const timeFilter = day === '2026-06-04'
    ? `AND time(s.entry_time) >= '17:30:00'`
    : '';
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
    WHERE date(s.entry_time) = ? ${timeFilter}
    ORDER BY s.entry_time DESC
  `).all(day);
}

function getSessionDates() {
  // Fechas de la agenda (eventos activos) + días pasados con sesiones reales contadas
  return db.prepare(`
    SELECT day, MAX(count) as count FROM (
      -- Fechas de la agenda (eventos programados)
      SELECT
        e.event_date as day,
        COUNT(CASE
          WHEN s.entry_time IS NOT NULL
            AND NOT (e.event_date = '2026-06-04' AND time(s.entry_time) < '17:30:00')
          THEN 1
        END) as count
      FROM events e
      LEFT JOIN sessions s ON date(s.entry_time) = e.event_date
      WHERE e.active = 1
      GROUP BY e.event_date
      UNION
      -- Días pasados con visitas reales contadas (ej. 4 jun aunque no esté en agenda)
      SELECT
        date(entry_time) as day,
        COUNT(*) as count
      FROM sessions
      WHERE counted_as_visit = 1
        AND NOT (date(entry_time) = '2026-06-04' AND time(entry_time) < '17:30:00')
      GROUP BY day
    )
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
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
  getPoints,
  getPointsHistory,
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
  ALLOWED_REACTIONS,
  acceptRaffle,
  rejectRaffle,
  getRaffleParticipation,
  getPrizePresets,
  addPrizePreset,
  deletePrizePreset,
  getRaffleCountTonight
};
