const fs = require('fs');

const createTable = `
CREATE TABLE IF NOT EXISTS level_decay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  penalty_visits INTEGER NOT NULL,
  missed_events_count INTEGER NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
);
`;

const dbCode = `
function checkAndApplyLevelDecay(walletAddress) {
  if (!walletAddress) return;
  // Solo aplicamos si el usuario tiene un mint (está registrado)
  const isRegistered = db.prepare(\`SELECT id FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'\`).get(walletAddress);
  if (!isRegistered) return;

  // 1. Obtener la última visita (sesión o visit legacy)
  const lastVisit = db.prepare(\`
    SELECT MAX(day) as last_day FROM (
      SELECT date(entry_time) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
      UNION
      SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(?)
    )
  \`).get(walletAddress, walletAddress);

  const lastVisitDate = lastVisit && lastVisit.last_day ? lastVisit.last_day : null;
  if (!lastVisitDate) return;

  // 2. Obtener el último cálculo de penalización para no contar los mismos eventos dos veces
  const lastDecay = db.prepare(\`SELECT date(MAX(applied_at)) as last_decay_date FROM level_decay_events WHERE LOWER(wallet_address) = LOWER(?)\`).get(walletAddress);
  const checkFromDate = (lastDecay && lastDecay.last_decay_date && lastDecay.last_decay_date > lastVisitDate) ? lastDecay.last_decay_date : lastVisitDate;

  // 3. Contar cuántos eventos ha habido desde esa fecha hasta hoy (excluyendo hoy)
  const missedEventsRow = db.prepare(\`
    SELECT COUNT(*) as missed FROM events 
    WHERE event_date > ? AND event_date < date('now', 'localtime')
  \`).get(checkFromDate);

  const missedEvents = missedEventsRow ? missedEventsRow.missed : 0;

  // 4. Calcular nivel actual efectivo para saber si decay aplica
  const baseVisits = getVisitCount(walletAddress); // Incluye penalizaciones porque lo modificaremos
  const currentLevel = levelForVisitCount(baseVisits) || 1;

  if (currentLevel === 4 && missedEvents >= 24) {
    db.prepare(\`INSERT INTO level_decay_events (wallet_address, penalty_visits, missed_events_count) VALUES (?, ?, ?)\`).run(walletAddress, 8, missedEvents);
  } else if (currentLevel === 3 && missedEvents >= 8) {
    db.prepare(\`INSERT INTO level_decay_events (wallet_address, penalty_visits, missed_events_count) VALUES (?, ?, ?)\`).run(walletAddress, 2, missedEvents);
  } else if (currentLevel === 2 && missedEvents >= 4) {
    db.prepare(\`INSERT INTO level_decay_events (wallet_address, penalty_visits, missed_events_count) VALUES (?, ?, ?)\`).run(walletAddress, 1, missedEvents);
  }
}
`;
console.log('Script written');
