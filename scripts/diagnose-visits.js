// DIAGNÓSTICO (read-only) del "Kilometraje Furancheiro" de una billetera.
// Desglosa día a día qué cuenta como visita y de dónde sale, y MARCA como
// sospechosas las sesiones contadas (counted_as_visit=1) en días SIN un Furancho
// activo en la agenda — es decir, visitas que inflan el nivel sin ser un fichaje
// real de sesión (p.ej. visitas de terraza metidas por error como sesión).
//
// No modifica NADA. Sirve para auditar cualquier cliente.
//
// Uso:  node scripts/diagnose-visits.js 0xTUBILLETERA

const { db, getVisitCount } = require('../db/database');

const wallet = (process.argv[2] || '').trim();
if (!/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
  console.error('Uso: node scripts/diagnose-visits.js 0x<billetera de 40 hex>');
  process.exit(1);
}

const total = getVisitCount(wallet);
console.log(`\nBilletera: ${wallet}`);
console.log(`Kilometraje (getVisitCount): ${total} visitas\n`);

// Días que cuentan desde sessions (counted_as_visit=1)
const sessDays = db.prepare(`
  SELECT date(entry_time) AS day, COUNT(*) AS n, MIN(id) AS anyId
  FROM sessions
  WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
  GROUP BY date(entry_time) ORDER BY day
`).all(wallet);

// Días que cuentan desde la tabla legacy visits
const visitDays = db.prepare(`
  SELECT date(visited_at) AS day, COUNT(*) AS n
  FROM visits WHERE LOWER(wallet_address) = LOWER(?)
  GROUP BY date(visited_at) ORDER BY day
`).all(wallet);

// ¿Hubo un Furancho ACTIVO ese día? (evento activo en la agenda)
const eventOnDay = db.prepare(`SELECT COUNT(*) c FROM events WHERE event_date = ? AND active = 1`);
const isEventDay = (day) => eventOnDay.get(day).c > 0;

console.log('— Días contados desde SESSIONS (fichaje) —');
let suspicious = 0;
for (const r of sessDays) {
  const ev = isEventDay(r.day);
  const flag = ev ? 'OK  (Furancho activo)' : '⚠️  SOSPECHOSA (sin Furancho activo ese día)';
  if (!ev) suspicious++;
  console.log(`  ${r.day}  ${r.n} sesión(es)  →  ${flag}`);
}
if (sessDays.length === 0) console.log('  (ninguno)');

console.log('\n— Días contados desde VISITS (legacy) —');
for (const r of visitDays) console.log(`  ${r.day}  ${r.n} registro(s)`);
if (visitDays.length === 0) console.log('  (ninguno)');

// Días únicos combinados (lo que realmente cuenta)
const allDays = new Set([...sessDays.map(r => r.day), ...visitDays.map(r => r.day)]);
console.log(`\nDías únicos que suman al Kilometraje: ${allDays.size}`);
console.log(`Sesiones contadas en días SIN Furancho activo (posibles fantasmas): ${suspicious}`);
if (suspicious > 0) {
  console.log('\n→ Esas visitas sospechosas probablemente inflan el nivel. Si confirmas que');
  console.log('  fueron terraza/Reto de los 5 (no sesión), hay que quitarlas de `sessions`');
  console.log('  (su crédito de campaña vive aparte en `campaign_visits`).');
}
console.log('');
