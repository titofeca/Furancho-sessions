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
  return !!row;
}

function getVisitCount(walletAddress) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE wallet_address = ?`).get(walletAddress);
  return row ? row.count : 0;
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
  const totalVisits = totalVisitsRow ? totalVisitsRow.count : 0;

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

module.exports = {
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
  getVisitCount
};
