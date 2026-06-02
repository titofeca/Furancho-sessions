const fs = require('fs');
const path = './db/database.js';
let content = fs.readFileSync(path, 'utf8');

// 1. Add sessions table
const tableSql = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    entry_time TEXT DEFAULT (datetime('now')),
    exit_time TEXT,
    duration_minutes INTEGER,
    counted_as_visit INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet_address);
`;
content = content.replace("CREATE INDEX IF NOT EXISTS idx_visits_wallet ON visits(wallet_address);", "CREATE INDEX IF NOT EXISTS idx_visits_wallet ON visits(wallet_address);\n" + tableSql);

// 2. Replace checkRecentVisit
const newCheckRecent = `
function checkRecentVisit(walletAddress, hours = 12) {
  const row = db.prepare(\`
    SELECT visited_at 
    FROM visits 
    WHERE wallet_address = ? 
      AND visited_at >= datetime('now', '-\${hours} hours')
    ORDER BY visited_at DESC 
    LIMIT 1
  \`).get(walletAddress);
  const row2 = db.prepare(\`
    SELECT exit_time
    FROM sessions
    WHERE wallet_address = ? 
      AND exit_time >= datetime('now', '-\${hours} hours')
      AND counted_as_visit = 1
    ORDER BY exit_time DESC 
    LIMIT 1
  \`).get(walletAddress);
  return !!row || !!row2;
}`;
content = content.replace(/function checkRecentVisit[\s\S]*?return !!row;\n}/, newCheckRecent);

// 3. Replace getVisitCount
const newGetVisitCount = `
function getVisitCount(walletAddress) {
  const row = db.prepare(\`SELECT COUNT(*) as count FROM visits WHERE wallet_address = ?\`).get(walletAddress);
  const row2 = db.prepare(\`SELECT COUNT(*) as count FROM sessions WHERE wallet_address = ? AND counted_as_visit = 1\`).get(walletAddress);
  return (row ? row.count : 0) + (row2 ? row2.count : 0);
}`;
content = content.replace(/function getVisitCount[\s\S]*?return row \? row\.count : 0;\n}/, newGetVisitCount);

// 4. Update getStats totalVisits
content = content.replace(
  "const totalVisitsRow = db.prepare(`SELECT COUNT(*) as count FROM visits`).get();\n  const totalVisits = totalVisitsRow ? totalVisitsRow.count : 0;",
  "const totalVisitsRow = db.prepare(`SELECT COUNT(*) as count FROM visits`).get();\n  const totalSessionsRow = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE counted_as_visit = 1`).get();\n  const totalVisits = (totalVisitsRow ? totalVisitsRow.count : 0) + (totalSessionsRow ? totalSessionsRow.count : 0);"
);

// 5. Add session functions
const sessionFuncs = `
function openSession(walletAddress) {
  const openSession = db.prepare(\`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1\`).get(walletAddress);
  if (!openSession) {
    db.prepare(\`INSERT INTO sessions (wallet_address) VALUES (?)\`).run(walletAddress);
  }
}

function closeSession(walletAddress) {
  const session = db.prepare(\`
    SELECT id, entry_time FROM sessions 
    WHERE wallet_address = ? AND exit_time IS NULL 
    ORDER BY entry_time DESC LIMIT 1
  \`).get(walletAddress);

  if (session) {
    const entryDate = new Date(session.entry_time + 'Z');
    const now = new Date();
    let diffMinutes = Math.floor((now - entryDate) / 60000);
    // Asignar 60 min si pasaron mas de 12 horas o es negativo
    if (diffMinutes > 12 * 60 || diffMinutes < 0) {
      diffMinutes = 60;
    }
    db.prepare(\`
      UPDATE sessions 
      SET exit_time = datetime('now'), duration_minutes = ?, counted_as_visit = 1 
      WHERE id = ?
    \`).run(diffMinutes, session.id);
  } else {
    // Sesion huerfana: no escaneo a la entrada. Damos 60 min
    db.prepare(\`
      INSERT INTO sessions (wallet_address, entry_time, exit_time, duration_minutes, counted_as_visit) 
      VALUES (?, datetime('now', '-60 minutes'), datetime('now'), 60, 1)
    \`).run(walletAddress);
  }
}
`;

content = content.replace("module.exports = {", sessionFuncs + "\nmodule.exports = {\n  openSession,\n  closeSession,");

fs.writeFileSync(path, content);
console.log('Database updated');
