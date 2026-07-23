#!/usr/bin/env node
/**
 * AUDITORÍA DE PUNTOS CRÍTICOS — Furancho Sessions
 * ================================================
 * Chequeo READ-ONLY (no escribe nada nuevo) de los flujos que NO se pueden romper:
 * fichajes, $CORCHO (nadie gana/gasta de más ni compra gratis), sorteos, canjes,
 * dobles cuentas y config de la noche.
 *
 * Uso:
 *   node scripts/critical-audit.js                 # audita la BD del entorno (en Railway = producción)
 *   node scripts/critical-audit.js --url=https://... # + smoke test HTTP (solo GET, sin efectos)
 *
 * Salida: informe con ✅/❌ y código de salida 0 (todo OK) o 1 (algo falla) → sirve para
 * cron/CI. Pensado para correr CADA SEMANA y antes de una noche importante.
 *
 * Regla de oro (ver memoria "flujos críticos intocables"): si algo aquí sale ❌, NO se
 * deploya ni se abre la noche sin arreglarlo.
 */

'use strict';

const results = [];
let hadError = false;

function check(name, fn) {
  try {
    const r = fn();
    const ok = r === true || (r && r.ok !== false);
    const detail = (r && typeof r === 'object' && r.detail) ? r.detail : '';
    results.push({ name, ok, detail });
    if (!ok) hadError = true;
  } catch (e) {
    results.push({ name, ok: false, detail: 'EXCEPCIÓN: ' + e.message });
    hadError = true;
  }
}

async function checkAsync(name, fn) {
  try {
    const r = await fn();
    const ok = r === true || (r && r.ok !== false);
    const detail = (r && typeof r === 'object' && r.detail) ? r.detail : '';
    results.push({ name, ok, detail });
    if (!ok) hadError = true;
  } catch (e) {
    results.push({ name, ok: false, detail: 'EXCEPCIÓN: ' + e.message });
    hadError = true;
  }
}

// ── 0. BOOT: el módulo db carga sin ReferenceError y exporta funciones reales ──
// (Este bug ya tiró el servidor una vez: exportar una función sin definirla.)
let db, dbModule;
check('BOOT · el módulo db/database.js carga sin crashear', () => {
  dbModule = require('../db/database');
  db = dbModule.db;
  return { ok: !!db, detail: db ? 'BD abierta' : 'no hay handle db' };
});

check('BOOT · ningún export del módulo db es undefined', () => {
  const bad = Object.keys(dbModule).filter(k => dbModule[k] === undefined);
  return { ok: bad.length === 0, detail: bad.length ? 'undefined: ' + bad.join(', ') : 'todos definidos' };
});

const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

// ── 1. $CORCHO · nadie tiene saldo negativo (el gasto es atómico) ──
check('$CORCHO · sin saldos negativos', () => {
  const r = one(`SELECT COUNT(*) c FROM corcho_balances WHERE balance < 0`);
  return { ok: r.c === 0, detail: r.c === 0 ? '0 saldos negativos' : `${r.c} wallets con saldo NEGATIVO` };
});

// ── 2. $CORCHO · coherencia balance = ganado - gastado (por fila) ──
check('$CORCHO · balance = total_earned − total_spent', () => {
  const rows = all(`SELECT wallet_address, balance, total_earned, total_spent
                    FROM corcho_balances WHERE balance != total_earned - total_spent`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'cuadra en todas las wallets'
    : `${rows.length} wallets descuadradas (ej: ${rows[0].wallet_address.slice(0,10)})` };
});

// ── 3. $CORCHO · el LIBRO (transacciones) cuadra con el saldo ──
// Suma de corcho_transactions.amount por wallet == balance. Esto caza CUALQUIER
// escritura de saldo por fuera de add/spend (la única vía legítima de "de más").
check('$CORCHO · la suma del libro == saldo (sin saldo fantasma)', () => {
  const rows = all(`
    SELECT b.wallet_address, b.balance, COALESCE(t.sum_amount, 0) AS ledger
    FROM corcho_balances b
    LEFT JOIN (SELECT LOWER(wallet_address) w, SUM(amount) sum_amount
               FROM corcho_transactions GROUP BY LOWER(wallet_address)) t
      ON LOWER(b.wallet_address) = t.w
    WHERE b.balance != COALESCE(t.sum_amount, 0)`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'libro y saldo cuadran'
    : `${rows.length} wallets con saldo que NO sale del libro (ej: ${rows[0].wallet_address.slice(0,10)} bal=${rows[0].balance} libro=${rows[0].ledger})` };
});

// ── 4. $CORCHO · sin doble-crédito en recompensas idempotentes ──
// checkin/exit/level_award/campaign_visit/referral: máx 1 crédito por (wallet,type,refId).
check('$CORCHO · sin doble-crédito en recompensas (fichar, salida, niveles, campaña, referido)', () => {
  const rows = all(`
    SELECT LOWER(wallet_address) w, type, reference_id, COUNT(*) c, SUM(amount) tot
    FROM corcho_transactions
    WHERE amount > 0 AND reference_id IS NOT NULL
      AND type IN ('checkin','exit','level_award','campaign_visit','referral')
    GROUP BY LOWER(wallet_address), type, reference_id
    HAVING COUNT(*) > 1`);
  const extra = rows.reduce((s, r) => s + (r.tot - r.tot / r.c), 0);
  return { ok: rows.length === 0, detail: rows.length === 0 ? '1 crédito por acción, sin duplicados'
    : `${rows.length} refs duplicadas (~${Math.round(extra)} $CORCHO de más). Ej: ${rows[0].type}/${rows[0].reference_id} ×${rows[0].c}` };
});

// ── 5. $CORCHO · comprar NO acredita gratis (solo tras validar el pago) ──
// Todo crédito 'buy_pack' debe tener su solicitud confirmada; y ninguna solicitud
// pendiente/cancelada puede haber acreditado.
check('$CORCHO · compras acreditadas solo si la solicitud está CONFIRMADA', () => {
  const orphans = all(`
    SELECT t.reference_id, t.wallet_address, t.amount
    FROM corcho_transactions t
    WHERE t.type = 'buy_pack'
      AND NOT EXISTS (
        SELECT 1 FROM corcho_pack_requests r
        WHERE 'packreq_' || r.id = t.reference_id AND r.status = 'confirmed')`);
  return { ok: orphans.length === 0, detail: orphans.length === 0 ? 'ninguna recarga sin pago validado'
    : `${orphans.length} recargas acreditadas SIN solicitud confirmada (¡monedas gratis!) ej: ${orphans[0].reference_id}` };
});

// ── 6. $CORCHO · comprar no se acredita dos veces (no doble-confirm) ──
check('$CORCHO · sin doble-confirmación de la misma recarga', () => {
  const rows = all(`
    SELECT reference_id, COUNT(*) c FROM corcho_transactions
    WHERE type = 'buy_pack' AND reference_id IS NOT NULL
    GROUP BY reference_id HAVING COUNT(*) > 1`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'cada recarga acreditada 1 vez'
    : `${rows.length} recargas acreditadas MÁS de una vez (ej: ${rows[0].reference_id} ×${rows[0].c})` };
});

// ── 7. $CORCHO · solicitudes de compra PENDIENTES no han tocado saldo ──
check('$CORCHO · solicitudes pendientes no acreditan hasta validarse', () => {
  const bad = all(`
    SELECT r.id FROM corcho_pack_requests r
    WHERE r.status IN ('pending','cancelled')
      AND EXISTS (SELECT 1 FROM corcho_transactions t
                  WHERE t.type='buy_pack' AND t.reference_id = 'packreq_' || r.id)`);
  return { ok: bad.length === 0, detail: bad.length === 0 ? 'pendientes/canceladas a 0'
    : `${bad.length} solicitudes NO confirmadas que YA acreditaron (ej id ${bad[0].id})` };
});

// ── 8. FICHAJE · ninguna wallet con más de una sesión ABIERTA a la vez ──
// (El sistema cierra las huérfanas de días previos; >1 abierta = anomalía.)
check('FICHAJE · sin sesiones abiertas duplicadas por wallet', () => {
  const rows = all(`
    SELECT LOWER(wallet_address) w, COUNT(*) c FROM sessions
    WHERE exit_time IS NULL GROUP BY LOWER(wallet_address) HAVING COUNT(*) > 1`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'como mucho 1 sesión abierta por wallet'
    : `${rows.length} wallets con varias sesiones abiertas (ej: ${rows[0].w.slice(0,10)} ×${rows[0].c})` };
});

// ── 9. ONBOARDING · sin cuentas $CORCHO duplicadas (PK wallet) ──
check('ONBOARDING · sin wallets duplicadas en el banco', () => {
  const rows = all(`SELECT LOWER(wallet_address) w, COUNT(*) c FROM corcho_balances
                    GROUP BY LOWER(wallet_address) HAVING COUNT(*) > 1`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'una cuenta por wallet'
    : `${rows.length} wallets duplicadas` };
});

// ── 10. REFERIDOS · cada amigo referido cuenta una sola vez ──
check('REFERIDOS · sin referido contado dos veces', () => {
  const rows = all(`SELECT LOWER(referred_wallet) w, COUNT(*) c FROM referrals
                    GROUP BY LOWER(referred_wallet) HAVING COUNT(*) > 1`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'cada referido único'
    : `${rows.length} referidos duplicados` };
});

// ── 11. PRIVILEXIO TAPA · sin doble-canje del mismo NFT en el mismo día ──
check('PRIVILEXIO · sin doble-canje del mismo NFT/día (tapa gratis)', () => {
  const rows = all(`
    SELECT nft_type, nft_id, serial, claim_date, COUNT(*) c FROM daily_tapa_claims
    GROUP BY nft_type, nft_id, serial, claim_date HAVING COUNT(*) > 1`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'un canje por NFT y día'
    : `${rows.length} NFTs canjeados 2+ veces el mismo día (ej: ${rows[0].nft_id} ${rows[0].claim_date})` };
});

// ── 12. SORTEOS/VALES · sin códigos de canje duplicados ──
check('CANJES · códigos de vale únicos (sorteos y $CORCHO)', () => {
  const a = one(`SELECT COUNT(*) c FROM (SELECT code FROM redemptions GROUP BY code HAVING COUNT(*)>1)`);
  const b = one(`SELECT COUNT(*) c FROM (SELECT code FROM corcho_redemptions GROUP BY code HAVING COUNT(*)>1)`);
  const bad = a.c + b.c;
  return { ok: bad === 0, detail: bad === 0 ? 'todos los códigos únicos' : `${bad} códigos duplicados` };
});

// ── 13. VALES $CORCHO · un vale validado tuvo su gasto (no entrega sin cobro) ──
check('CANJES · vales validados nacieron de un gasto real de saldo', () => {
  // Cada canje (pending o validado) debe tener su transacción de gasto (amount<0, type redeem-ish).
  // Comprobamos que no haya vales validados sin NINGÚN gasto de esa wallet por ese importe.
  const rows = all(`
    SELECT cr.code, cr.wallet_address, cr.price_corcho
    FROM corcho_redemptions cr
    WHERE cr.status = 'validated'
      AND NOT EXISTS (
        SELECT 1 FROM corcho_transactions t
        WHERE LOWER(t.wallet_address) = LOWER(cr.wallet_address)
          AND t.amount = -cr.price_corcho)`);
  return { ok: rows.length === 0, detail: rows.length === 0 ? 'cada vale entregado se pagó con saldo'
    : `${rows.length} vales validados SIN gasto de saldo (ej ${rows[0].code})` };
});

// ── 14. CONFIG NOCHE · el/los NFT del privilexio existen en el catálogo ──
check('CONFIG · NFT(s) del privilexio de tapa existen en el catálogo', () => {
  const enabled = (one(`SELECT value FROM app_settings WHERE key='daily_tapa_enabled'`) || {}).value === '1';
  if (!enabled) return { ok: true, detail: 'privilexio desactivado (nada que validar)' };
  const raw = (one(`SELECT value FROM app_settings WHERE key='daily_tapa_nft'`) || {}).value || 'guardian_furancho';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  let catalog = [];
  try { catalog = require('../services/achievements').list().map(c => c.id); } catch (_) {}
  const missing = ids.filter(id => id !== 'guardian_furancho' && !catalog.includes(id));
  return { ok: missing.length === 0, detail: missing.length === 0
    ? `activo · NFTs OK (${ids.join(', ')})` : `NFT(s) inexistentes: ${missing.join(', ')}` };
});

// ── 15. CONFIG NOCHE · tarifas de $CORCHO presentes y coherentes ──
check('CONFIG · tarifas de recompensa $CORCHO cargadas', () => {
  let rates;
  try { rates = require('../services/corcho').getEconomySettings(); } catch (e) { return { ok: false, detail: 'no se pudo leer services/corcho' }; }
  const keys = ['checkin', 'exit'];
  const missing = keys.filter(k => typeof rates[k] !== 'number');
  const negatives = Object.entries(rates).filter(([, v]) => typeof v === 'number' && v < 0).map(([k]) => k);
  const ok = missing.length === 0 && negatives.length === 0;
  return { ok, detail: ok ? `fichar=${rates.checkin} · salida=${rates.exit}`
    : `faltan: ${missing.join(',') || '—'} · negativas: ${negatives.join(',') || '—'}` };
});

// ── Runtime opcional: smoke test HTTP (solo GET, sin efectos) ──
async function httpSmoke(baseUrl) {
  const get = async (path) => {
    const res = await fetch(baseUrl.replace(/\/$/, '') + path, { method: 'GET' });
    return { status: res.status, ct: res.headers.get('content-type') || '' };
  };
  await checkAsync(`HTTP · GET /claim responde 200`, async () => {
    const r = await get('/claim'); return { ok: r.status === 200, detail: `status ${r.status}` };
  });
  await checkAsync(`HTTP · GET /manifest.json responde 200`, async () => {
    const r = await get('/manifest.json'); return { ok: r.status === 200, detail: `status ${r.status}` };
  });
  await checkAsync(`HTTP · privilexio de tapa consultable (API viva)`, async () => {
    const r = await get('/api/mint/daily-tapa-status?wallet=0x0000000000000000000000000000000000000001');
    return { ok: r.status === 200 && r.ct.includes('json'), detail: `status ${r.status}` };
  });
}

(async () => {
  const urlArg = process.argv.find(a => a.startsWith('--url='));
  const url = urlArg ? urlArg.slice('--url='.length) : (process.env.AUDIT_URL || '');
  if (url) await httpSmoke(url);

  // ── Informe ──
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  AUDITORÍA DE PUNTOS CRÍTICOS · Furancho Sessions');
  console.log('  ' + new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }) + ' (Madrid)');
  console.log('═══════════════════════════════════════════════════════════\n');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'}  ${r.name}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log('\n───────────────────────────────────────────────────────────');
  console.log(`  RESULTADO: ${pass}/${results.length} OK` + (fail ? `  ·  ⚠️  ${fail} FALLO(S)` : '  ·  🍷 todo en orden'));
  console.log('───────────────────────────────────────────────────────────\n');

  process.exit(hadError ? 1 : 0);
})();
