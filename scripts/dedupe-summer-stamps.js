// Deja 1 sello por wallet y día en el Pasaporte de Verano (regla nueva: 1/día).
// Conserva el sello más antiguo de cada wallet+día y borra los extra. Read-only
// por defecto; usa --apply para aplicar.
//
// Uso:
//   node scripts/dedupe-summer-stamps.js           → DRY-RUN (solo lista)
//   node scripts/dedupe-summer-stamps.js --apply    → aplica

const { db } = require('../db/database');
const APPLY = process.argv.includes('--apply');

const dups = db.prepare(`
  SELECT LOWER(wallet_address) w, stamp_date, COUNT(*) c, MIN(id) keepId
  FROM summer_stamps
  GROUP BY LOWER(wallet_address), stamp_date
  HAVING COUNT(*) > 1
`).all();

if (dups.length === 0) {
  console.log('✅ No hay días con más de un sello. Nada que corregir.');
  process.exit(0);
}

let toRemove = 0;
console.log('Wallet/día con más de un sello:');
for (const d of dups) {
  const extra = d.c - 1;
  toRemove += extra;
  console.log(`  · ${d.w.slice(0, 12)}  ${d.stamp_date}  ${d.c} sellos → deja 1 (borra ${extra})`);
}
console.log(`\nSellos a borrar en total: ${toRemove}`);

if (!APPLY) {
  console.log('\n(DRY-RUN) No se ha borrado nada. Reejecuta con --apply para aplicar.');
  process.exit(0);
}

const del = db.prepare(`
  DELETE FROM summer_stamps
  WHERE id NOT IN (
    SELECT MIN(id) FROM summer_stamps GROUP BY LOWER(wallet_address), stamp_date
  )
`);
const res = del.run();
console.log(`\n✅ Borrados ${res.changes} sellos duplicados. Ahora hay 1 por wallet/día.`);
