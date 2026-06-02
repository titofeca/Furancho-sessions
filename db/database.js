// Usa el SQLite nativo de Node.js (v22+) — sin dependencias externas ni compilación
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'furancho.db');
const db = new DatabaseSync(DB_PATH);

// Activar WAL mode y foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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

`);

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

function getEligibleRaffleParticipants() {
  // Option A: Active sessions (entry_time is not null, exit_time is null)
  return db.prepare(`SELECT DISTINCT wallet_address FROM sessions WHERE exit_time IS NULL`).all().map(r => r.wallet_address);
}

function insertRaffle(prize, winnerWallet, verificationCode) {
  const stmt = db.prepare(`
    INSERT INTO raffles (prize, winner_wallet, verification_code)
    VALUES (?, ?, ?)
  `);
  return stmt.run(prize, winnerWallet, verificationCode).lastInsertRowid;
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
  insertRaffle
};
