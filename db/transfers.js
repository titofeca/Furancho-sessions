const { db } = require('./database');

function setupTransfersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_wallet TEXT NOT NULL,
      to_wallet TEXT NOT NULL,
      token_id INTEGER NOT NULL,
      private_key_enc TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      approved_at TEXT,
      tx_hash TEXT
    )
  `);
}

setupTransfersTable();

function createTransferRequest(fromWallet, toWallet, tokenId, privateKeyEnc) {
  const stmt = db.prepare(`
    INSERT INTO nft_transfers (from_wallet, to_wallet, token_id, private_key_enc)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(fromWallet, toWallet, tokenId, privateKeyEnc).lastInsertRowid;
}

function getPendingTransfers() {
  return db.prepare(`SELECT * FROM nft_transfers WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

function getTransferById(id) {
  return db.prepare(`SELECT * FROM nft_transfers WHERE id = ?`).get(id);
}

function updateTransferStatus(id, status, txHash = null) {
  if (txHash) {
    db.prepare(`UPDATE nft_transfers SET status = ?, tx_hash = ?, approved_at = datetime('now') WHERE id = ?`).run(status, txHash, id);
  } else {
    db.prepare(`UPDATE nft_transfers SET status = ? WHERE id = ?`).run(status, id);
  }
}

function getAppSetting(key, defaultValue = null) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
  return row ? row.value : defaultValue;
}

function setAppSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

module.exports = {
  createTransferRequest,
  getPendingTransfers,
  getTransferById,
  updateTransferStatus,
  getAppSetting,
  setAppSetting
};
