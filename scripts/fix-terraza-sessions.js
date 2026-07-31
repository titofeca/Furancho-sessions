// CORRECTOR: elimina las sesiones ERRÓNEAS creadas por add_retroactive_visits.js
// para los días de TERRAZA (19, 22 y 26 jul 2026 a las 18:00:00).
//
// Contexto: una visita de terraza (Reto de los 5) NO es un fichaje de entrada.
// Debe vivir SOLO en `campaign_visits`, nunca en `sessions`. El script retroactivo
// insertó por error filas en `sessions` con counted_as_visit=1 y sin exit_time, lo
// que (a) infló el "Kilometraje Furancheiro" y (b) dejó sesiones abiertas huérfanas.
//
// Este corrector SOLO borra esas filas de `sessions`. NO toca campaign_visits ni el
// $CORCHO ya acreditado (ambos son correctos). El nivel/NFT no se recalcula: los
// mints no se deshacen y el conteo de niveles se recomputa solo desde getVisitCount.
//
// Uso:
//   node scripts/fix-terraza-sessions.js          → DRY-RUN (solo lista, no borra)
//   node scripts/fix-terraza-sessions.js --apply   → aplica el borrado

const { db, getVisitCount } = require('../db/database');

const APPLY = process.argv.includes('--apply');

// Firma EXACTA de las inserciones del script retroactivo. Estricta a propósito para
// no rozar jamás un fichaje real (que usa datetime('now'), con segundos, y cierra
// o auto-cierra la sesión).
const BAD_ENTRY_TIMES = ['2026-07-19 18:00:00', '2026-07-22 18:00:00', '2026-07-26 18:00:00'];
const ph = BAD_ENTRY_TIMES.map(() => '?').join(',');

const bad = db.prepare(`
  SELECT id, wallet_address, entry_time
  FROM sessions
  WHERE entry_time IN (${ph})
    AND exit_time IS NULL
    AND counted_as_visit = 1
`).all(...BAD_ENTRY_TIMES);

if (bad.length === 0) {
  console.log('✅ No hay sesiones de terraza erróneas. Nada que corregir.');
  process.exit(0);
}

const wallets = [...new Set(bad.map(b => b.wallet_address.toLowerCase()))];
console.log(`Sesiones de terraza erróneas encontradas: ${bad.length}  ·  wallets afectadas: ${wallets.length}\n`);
for (const w of wallets) {
  const before = getVisitCount(w);
  const willRemove = bad.filter(b => b.wallet_address.toLowerCase() === w).length;
  // Días de visita legítimos tras el borrado (excluye las malas)
  const after = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT date(entry_time) d FROM sessions
        WHERE LOWER(wallet_address)=? AND counted_as_visit=1 AND entry_time NOT IN (${ph})
      UNION
      SELECT date(visited_at) d FROM visits WHERE LOWER(wallet_address)=?
    )
  `).get(w, ...BAD_ENTRY_TIMES, w).c;
  console.log(`  · ${w.slice(0, 12)}  Kilometraje ${before} → ${after}  (borra ${willRemove} sesiones de terraza)`);
}

if (!APPLY) {
  console.log('\n(DRY-RUN) No se ha borrado nada. Reejecuta con --apply para aplicar.');
  process.exit(0);
}

const del = db.prepare(`
  DELETE FROM sessions
  WHERE entry_time IN (${ph})
    AND exit_time IS NULL
    AND counted_as_visit = 1
`);
const res = del.run(...BAD_ENTRY_TIMES);
console.log(`\n✅ Borradas ${res.changes} sesiones de terraza erróneas.`);

const remaining = db.prepare(`
  SELECT LOWER(wallet_address) w, COUNT(*) c FROM sessions
  WHERE exit_time IS NULL GROUP BY LOWER(wallet_address) HAVING COUNT(*) > 1
`).all();
console.log(`Wallets con >1 sesión abierta restantes: ${remaining.length}`);
