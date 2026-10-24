const { db } = require('./database');

// `nft_transfers` la usan dos flujos distintos y cada uno la declaraba a su
// manera: el traspaso instantáneo (nft_type / nft_id / fee_paid, en
// database.js) y el traspaso con aprobación del admin (token_id /
// private_key_enc / status / approved_at / tx_hash, aquí). Como ambas eran
// CREATE TABLE IF NOT EXISTS, ganaba la que corriese primero y la otra se
// quedaba sin sus columnas: de ahí el "no such column: token_id" que tumbaba
// el listado de pendientes, la creación de solicitudes y el registro de los
// traspasos instantáneos.
//
// La tabla es ahora la unión de las dos, y se reconcilia una ya existente
// añadiendo lo que le falte. Las columnas se añaden, nunca se tocan ni se
// borran las que haya.
const COLUMNAS = {
  nft_type: 'TEXT',
  nft_id: 'TEXT',
  fee_paid: 'INTEGER DEFAULT 0',
  token_id: 'INTEGER',
  private_key_enc: 'TEXT',
  status: "TEXT DEFAULT 'pending'",
  approved_at: 'TEXT',
  tx_hash: 'TEXT'
};

function setupTransfersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_wallet TEXT NOT NULL,
      to_wallet TEXT NOT NULL,
      nft_type TEXT,
      nft_id TEXT,
      fee_paid INTEGER DEFAULT 0,
      token_id INTEGER,
      private_key_enc TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      approved_at TEXT,
      tx_hash TEXT
    )
  `);

  const tiene = new Set(db.prepare(`PRAGMA table_info(nft_transfers)`).all().map(c => c.name));
  const anadidas = [];
  for (const [nombre, tipo] of Object.entries(COLUMNAS)) {
    if (tiene.has(nombre)) continue;
    db.exec(`ALTER TABLE nft_transfers ADD COLUMN ${nombre} ${tipo}`);
    anadidas.push(nombre);
  }

  // Si `status` acaba de aparecer, las filas que ya había son traspasos
  // instantáneos YA hechos. Con el DEFAULT se quedarían en 'pending' y
  // saldrían en el panel como solicitudes por aprobar que nadie pidió.
  if (anadidas.includes('status')) {
    db.prepare(`UPDATE nft_transfers SET status = 'completed' WHERE status IS NULL OR status = 'pending'`).run();
  }
  if (anadidas.length) {
    console.log(`[DB] nft_transfers reconciliada — columnas añadidas: ${anadidas.join(', ')}`);
  }
}

setupTransfersTable();

function createTransferRequest(fromWallet, toWallet, tokenId, privateKeyEnc) {
  const stmt = db.prepare(`
    INSERT INTO nft_transfers (from_wallet, to_wallet, token_id, private_key_enc)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(fromWallet, toWallet, tokenId, privateKeyEnc).lastInsertRowid;
}

// OJO: nunca sacar private_key_enc de aquí — este listado viaja al navegador del admin.
function getPendingTransfers() {
  return db.prepare(`SELECT id, from_wallet, to_wallet, token_id, status, created_at, approved_at, tx_hash
                     FROM nft_transfers WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

function getTransferById(id) {
  return db.prepare(`SELECT * FROM nft_transfers WHERE id = ?`).get(id);
}

function updateTransferStatus(id, status, txHash = null) {
  // En cuanto el traspaso deja de estar pendiente, la clave privada del cliente se borra
  // de la base de datos: solo hace falta en el momento de firmar.
  const scrub = status !== 'pending' ? `, private_key_enc = ''` : '';
  if (txHash) {
    db.prepare(`UPDATE nft_transfers SET status = ?, tx_hash = ?, approved_at = datetime('now')${scrub} WHERE id = ?`).run(status, txHash, id);
  } else {
    db.prepare(`UPDATE nft_transfers SET status = ?${scrub} WHERE id = ?`).run(status, id);
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
