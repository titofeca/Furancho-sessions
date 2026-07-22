// ─────────────────────────────────────────────────────────────────────────────
//  TIENDA DEL MEME — fuente ÚNICA de todo lo relativo a comprar/vender el Meme VIP.
//
//  El Meme VIP (token 50) es el ÚNICO NFT que se compra con dinero; el resto se
//  ganan (asistencia, campañas, sorteos). Aquí vive:
//    · el límite IRREVERSIBLE de 300 unidades,
//    · el precio base y lo que incluye (editables por el admin),
//    · el precio creciente por unidad (el 2º meme de la misma wallet cuesta el
//      doble, el 3º el doble del 2º, y así),
//    · la venta (solicitud del cliente → cobro presencial → confirmación admin),
//    · lo que incluye cada meme vendido y su consumo/entrega.
//
//  Nada de esto toca las tablas ni las colas que ya funcionaban: achievement_mints
//  sigue siendo "esta wallet tiene el meme" (y su mint on-chain va por la cola de
//  logros de siempre). Las unidades EXTRA de una misma wallet se mintean por la
//  cola propia de este módulo.
// ─────────────────────────────────────────────────────────────────────────────

const { db, claimAchievement, getAchievementMint, getSetting, setSetting } = require('../db/database');

// ─── DECISIÓN IRREVERSIBLE ───────────────────────────────────────────────────
// Solo existirán 300 memes. NUNCA. Este número no se edita desde el panel, no se
// lee de la base de datos y no se pasa por parámetro a ninguna función: está aquí
// y solo aquí, y además lo blinda un trigger de SQLite (ver db/database.js). Si
// algún día alguien —incluido el dueño— quiere cambiarlo, tendría que tocar el
// código Y el trigger a mano: es a propósito, la escasez es la gracia del meme.
const MEME = Object.freeze({
  ACHIEVEMENT_ID: 'meme_vip',
  TOKEN_ID: 50,
  MAX_SUPPLY: 300
});

// ─── CONFIGURACIÓN EDITABLE (precio y venta abierta/cerrada) ─────────────────
// Se guarda en app_settings. OJO: aquí NO hay ninguna clave de "supply".
const K_PRICE = 'meme_shop_price_cents';
const K_MULT  = 'meme_shop_multiplier';
const K_OPEN  = 'meme_shop_open';
const K_NOTE  = 'meme_shop_note';

const K_CORCHO = 'meme_shop_price_corcho';

function getConfig() {
  const priceCents = parseInt(getSetting(K_PRICE, '4000'), 10) || 4000;
  const priceCorcho = parseInt(getSetting(K_CORCHO, '4000'), 10) || 4000;
  const multiplier = parseFloat(getSetting(K_MULT, '2')) || 1;
  return {
    priceCents,
    priceCorcho,
    multiplier: Math.max(1, multiplier),
    open: getSetting(K_OPEN, '1') !== '0',
    note: getSetting(K_NOTE, '') || ''
  };
}


// Guarda SOLO precio, multiplicador, apertura y nota.
function setConfig({ priceCents, priceCorcho, multiplier, open, note }) {
  if (priceCents !== undefined) {
    const c = Math.max(0, Math.round(Number(priceCents)));
    if (!isFinite(c)) throw new Error('Precio no válido');
    setSetting(K_PRICE, String(c));
  }
  if (priceCorcho !== undefined) {
    const co = Math.max(0, Math.round(Number(priceCorcho)));
    if (!isFinite(co)) throw new Error('Precio en CorchoCoins no válido');
    setSetting(K_CORCHO, String(co));
  }
  if (multiplier !== undefined) {
    const m = Number(multiplier);
    if (!isFinite(m) || m < 1 || m > 10) throw new Error('El multiplicador va de 1 (precio plano) a 10');
    setSetting(K_MULT, String(m));
  }
  if (open !== undefined) setSetting(K_OPEN, open ? '1' : '0');
  if (note !== undefined) setSetting(K_NOTE, note || '');
  return getConfig();
}


// ─── EXISTENCIAS ─────────────────────────────────────────────────────────────
// Los mints fallidos no cuentan (se pueden reintentar). Incluye los memes
// entregados antes de existir la tienda (se registraron como 'historico').
function supply() {
  const sold = db.prepare(`SELECT COUNT(*) c FROM meme_units WHERE status != 'failed'`).get().c || 0;
  return { max: MEME.MAX_SUPPLY, sold, left: Math.max(0, MEME.MAX_SUPPLY - sold) };
}

function unitsOfWallet(wallet) {
  return db.prepare(`SELECT * FROM meme_units WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'
                     ORDER BY serial ASC`).all(wallet);
}

// Precio de la SIGUIENTE unidad para esta wallet: base · multiplicador^(memes que ya tiene).
// El 1º al precio base, el 2º el doble, el 3º el doble del 2º… La criptografía no
// permite prohibir tener varios; el precio sí desincentiva acaparar.
function priceForWallet(wallet) {
  const cfg = getConfig();
  const owned = wallet ? unitsOfWallet(wallet).length : 0;
  const cents = Math.round(cfg.priceCents * Math.pow(cfg.multiplier, owned));
  return { index: owned + 1, owned, cents, baseCents: cfg.priceCents, multiplier: cfg.multiplier };
}

// ─── QUÉ INCLUYE (catálogo editable) ─────────────────────────────────────────
function listPerks(onlyActive = false) {
  return db.prepare(`SELECT * FROM meme_perks ${onlyActive ? 'WHERE active = 1' : ''}
                     ORDER BY sort_order ASC, id ASC`).all();
}

function createPerk({ emoji, label, qty, kind, sortOrder }) {
  if (!label || !String(label).trim()) throw new Error('Falta el nombre de lo que incluye');
  const q = Math.max(1, parseInt(qty || 1, 10));
  const k = kind === 'entrega' ? 'entrega' : 'consumible';
  const info = db.prepare(`INSERT INTO meme_perks (emoji, label, qty, kind, sort_order)
                           VALUES (?, ?, ?, ?, ?)`)
    .run(emoji || '🎁', String(label).trim(), q, k, parseInt(sortOrder || 0, 10));
  return db.prepare(`SELECT * FROM meme_perks WHERE id = ?`).get(info.lastInsertRowid);
}

function updatePerk(id, { emoji, label, qty, kind, active, sortOrder }) {
  const row = db.prepare(`SELECT * FROM meme_perks WHERE id = ?`).get(id);
  if (!row) throw new Error('No existe eso que incluye');
  const fields = [], vals = [];
  if (emoji !== undefined) { fields.push('emoji = ?'); vals.push(emoji || '🎁'); }
  if (label !== undefined) {
    if (!String(label).trim()) throw new Error('El nombre no puede quedar vacío');
    fields.push('label = ?'); vals.push(String(label).trim());
  }
  if (qty !== undefined) { fields.push('qty = ?'); vals.push(Math.max(1, parseInt(qty, 10) || 1)); }
  if (kind !== undefined) { fields.push('kind = ?'); vals.push(kind === 'entrega' ? 'entrega' : 'consumible'); }
  if (active !== undefined) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (sortOrder !== undefined) { fields.push('sort_order = ?'); vals.push(parseInt(sortOrder, 10) || 0); }
  if (!fields.length) return row;
  vals.push(id);
  db.prepare(`UPDATE meme_perks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare(`SELECT * FROM meme_perks WHERE id = ?`).get(id);
}

// Borrar del catálogo NO quita nada a quien ya compró: lo vendido vive en
// meme_entitlements, que es una foto fija del momento de la venta.
function deletePerk(id) {
  return db.prepare(`DELETE FROM meme_perks WHERE id = ?`).run(id).changes > 0;
}

// ─── SOLICITUDES DE COMPRA (cliente) ─────────────────────────────────────────
function pendingRequestOf(wallet) {
  return db.prepare(`SELECT * FROM meme_purchases WHERE LOWER(wallet_address) = LOWER(?)
                     AND status = 'requested' ORDER BY id DESC LIMIT 1`).get(wallet);
}

function requestPurchase(wallet, note) {
  const cfg = getConfig();
  if (!cfg.open) throw new Error('La venta del meme está cerrada ahora mismo, ho.');
  const s = supply();
  if (s.left <= 0) throw new Error('Non queda ningún meme: los 300 están vendidos. Y no habrá más.');
  const already = pendingRequestOf(wallet);
  if (already) return { request: already, alreadyRequested: true };
  const p = priceForWallet(wallet);
  const info = db.prepare(`INSERT INTO meme_purchases (wallet_address, status, price_cents, unit_index, note)
                           VALUES (?, 'requested', ?, ?, ?)`)
    .run(wallet, p.cents, p.index, note || null);
  return { request: db.prepare(`SELECT * FROM meme_purchases WHERE id = ?`).get(info.lastInsertRowid), alreadyRequested: false };
}

function cancelRequest(id) {
  return db.prepare(`UPDATE meme_purchases SET status = 'cancelled', resolved_at = datetime('now')
                     WHERE id = ? AND status = 'requested'`).run(id).changes > 0;
}

function listRequests(status = 'requested') {
  return db.prepare(`SELECT * FROM meme_purchases WHERE status = ? ORDER BY id DESC`).all(status);
}

// ─── VENTA ───────────────────────────────────────────────────────────────────
// Confirma la venta (el admin ya ha cobrado en el local) o entrega un meme de
// regalo. Todo dentro de una transacción: o se registra la unidad con lo que
// incluye, o no se registra nada.
//   source: 'venta' (cobrada) | 'regalo' (sorteo/detalle: NO lleva extras)
function sellTo(wallet, { purchaseId = null, source = 'venta', priceCents = null, withPerks = true } = {}) {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) throw new Error('Wallet no válida');
  const s = supply();
  if (s.left <= 0) throw new Error(`Se han vendido los ${MEME.MAX_SUPPLY} memes. No hay más, y no los habrá.`);

  // Venta contra una solicitud: tiene que seguir viva. Así dos toques seguidos
  // (o dos móviles a la vez) no venden dos memes por el mismo cobro.
  if (purchaseId) {
    const p = db.prepare(`SELECT * FROM meme_purchases WHERE id = ?`).get(purchaseId);
    if (!p) throw new Error('Esa solicitud ya no existe');
    if (p.status !== 'requested') throw new Error('Esa solicitud ya se cobró o se descartó, ho. Refresca la lista.');
    if (String(p.wallet_address).toLowerCase() !== String(wallet).toLowerCase()) {
      throw new Error('La solicitud es de otro cliente');
    }
  }

  const price = priceCents != null ? Math.max(0, Math.round(priceCents)) : priceForWallet(wallet).cents;
  const perks = withPerks ? listPerks(true) : [];
  let needsAchQueue = false;
  let needsMemeQueue = false;

  let out;
  db.exec('BEGIN TRANSACTION');
  try {
    // Primer meme de esta wallet → se registra también en achievement_mints, que es
    // lo que ya pinta el museo y lo que mintea la cola de logros de siempre.
    let achMintId = null;
    const existing = getAchievementMint(wallet, MEME.ACHIEVEMENT_ID);
    if (!existing) {
      claimAchievement(wallet, MEME.ACHIEVEMENT_ID, MEME.TOKEN_ID, 'pending');
      const row = getAchievementMint(wallet, MEME.ACHIEVEMENT_ID);
      achMintId = row ? row.id : null;
      needsAchQueue = true;
    } else if (existing.status === 'failed') {
      // Su meme anterior no llegó a mintearse (RPC caído, p.ej.): esta venta
      // reaprovecha esa fila y la reintenta, en vez de dejarla muerta en el museo.
      db.prepare(`UPDATE achievement_mints SET status = 'pending', tx_hash = NULL WHERE id = ?`).run(existing.id);
      // La unidad fallida anterior se desengancha: si no, al reintentar el mint
      // heredaría el 'success' y contaría dos veces contra las 300.
      db.prepare(`UPDATE meme_units SET achievement_mint_id = NULL WHERE achievement_mint_id = ? AND status = 'failed'`).run(existing.id);
      achMintId = existing.id;
      needsAchQueue = true;
    } else {
      // Ya tiene meme: esta copia extra se mintea por la cola propia del meme.
      needsMemeQueue = true;
    }

    const serial = (db.prepare(`SELECT COALESCE(MAX(serial), 0) s FROM meme_units`).get().s || 0) + 1;
    // El trigger meme_units_max_supply aborta aquí si se intentase la unidad 301.
    const info = db.prepare(`INSERT INTO meme_units (serial, wallet_address, purchase_id, achievement_mint_id, source, price_cents, status)
                             VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
      .run(serial, wallet, purchaseId, achMintId, source, price);
    const unitId = info.lastInsertRowid;

    // Foto fija de lo que incluye: cambiar el catálogo después no altera esta venta.
    const insPerk = db.prepare(`INSERT INTO meme_entitlements (unit_id, wallet_address, emoji, label, kind, qty_total)
                                VALUES (?, ?, ?, ?, ?, ?)`);
    perks.forEach(p => insPerk.run(unitId, wallet, p.emoji, p.label, p.kind, p.qty));

    if (purchaseId) {
      db.prepare(`UPDATE meme_purchases SET status = 'paid', price_cents = ?, resolved_at = datetime('now')
                  WHERE id = ? AND status = 'requested'`).run(price, purchaseId);
    }
    out = { unitId, serial };
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    // El trigger de las 300 aborta aquí si alguien intentase la unidad 301.
    if (String(e.message || '').includes('MEME_SUPPLY_AGOTADO')) {
      throw new Error(`Se han vendido los ${MEME.MAX_SUPPLY} memes. No hay más, y no los habrá.`);
    }
    throw e;
  }

  // Colas fuera de la transacción (mintean on-chain de verdad).
  const polygon = require('./polygon');
  if (needsAchQueue) polygon.notifyAchievementQueue();
  if (needsMemeQueue) notifyMemeQueue();

  return {
    success: true, serial: out.serial, unitId: out.unitId, priceCents: price,
    perks: entitlementsOfUnit(out.unitId), supply: supply()
  };
}

// Cuando un cliente TRASPASA su meme a un amigo, la unidad viaja con el NFT: si
// no, el que lo regaló seguiría contando como dueño (y pagando el precio subido)
// y el que lo recibe seguiría comprando al precio de su primero.
// Lo que YA le debíamos (tapas, camiseta) NO viaja: eso lo pagó él y se lo
// tomará él. Si tiene varios, se va el más nuevo y conserva el número más bajo.
function moveUnitOnTransfer(fromWallet, toWallet) {
  try {
    const unit = db.prepare(`SELECT * FROM meme_units WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'
                             ORDER BY serial DESC LIMIT 1`).get(fromWallet);
    if (!unit) return { moved: false };
    db.prepare(`UPDATE meme_units SET wallet_address = ? WHERE id = ?`).run(toWallet, unit.id);
    return { moved: true, serial: unit.serial };
  } catch (e) {
    console.error('[MemeShop] No se pudo mover la unidad traspasada:', e.message);
    return { moved: false, error: e.message };
  }
}

// ─── LO QUE INCLUYE, YA VENDIDO ──────────────────────────────────────────────
function entitlementsOfUnit(unitId) {
  return db.prepare(`SELECT * FROM meme_entitlements WHERE unit_id = ? ORDER BY id ASC`).all(unitId);
}

function entitlementsOfWallet(wallet) {
  return db.prepare(`SELECT e.*, u.serial FROM meme_entitlements e
                     JOIN meme_units u ON u.id = e.unit_id
                     WHERE LOWER(e.wallet_address) = LOWER(?) AND u.status != 'failed'
                     ORDER BY u.serial ASC, e.id ASC`).all(wallet);
}

// Entrega/consume una unidad de lo incluido (una tapa, la camiseta…). Mientras
// queden usos, sigue pendiente; al agotarse, el cliente se queda solo con el meme.
function usePerk(entitlementId, qty = 1, note = null) {
  const e = db.prepare(`SELECT * FROM meme_entitlements WHERE id = ?`).get(entitlementId);
  if (!e) throw new Error('No encontrado');
  const n = Math.max(1, parseInt(qty, 10) || 1);
  if (e.qty_used + n > e.qty_total) throw new Error(`Ya no quedan ${e.label} en este meme, ho.`);
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare(`UPDATE meme_entitlements SET qty_used = qty_used + ?, updated_at = datetime('now') WHERE id = ?`).run(n, entitlementId);
    db.prepare(`INSERT INTO meme_entitlement_uses (entitlement_id, qty, note) VALUES (?, ?, ?)`).run(entitlementId, n, note);
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch (_) {} throw err; }
  return db.prepare(`SELECT * FROM meme_entitlements WHERE id = ?`).get(entitlementId);
}

// Deshacer la última entrega (dedo torpe en la barra).
function undoLastUse(entitlementId) {
  const last = db.prepare(`SELECT * FROM meme_entitlement_uses WHERE entitlement_id = ? ORDER BY id DESC LIMIT 1`).get(entitlementId);
  if (!last) throw new Error('No hay ninguna entrega que deshacer');
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare(`UPDATE meme_entitlements SET qty_used = MAX(0, qty_used - ?), updated_at = datetime('now') WHERE id = ?`).run(last.qty, entitlementId);
    db.prepare(`DELETE FROM meme_entitlement_uses WHERE id = ?`).run(last.id);
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch (_) {} throw err; }
  return db.prepare(`SELECT * FROM meme_entitlements WHERE id = ?`).get(entitlementId);
}

// Todo lo que el local tiene PENDIENTE de dar (tapas por consumir, camisetas sin
// stock…), agrupado por cliente. Es la lista de trabajo del panel.
function pendingDeliveries() {
  return db.prepare(`SELECT e.*, u.serial, u.created_at AS sold_at
                     FROM meme_entitlements e
                     JOIN meme_units u ON u.id = e.unit_id
                     WHERE e.qty_used < e.qty_total AND u.status != 'failed'
                     ORDER BY (e.kind = 'entrega') DESC, u.serial ASC, e.id ASC`).all();
}

// Resumen para el panel: existencias, caja y pendientes.
function adminOverview() {
  const s = supply();
  const money = db.prepare(`SELECT COALESCE(SUM(price_cents), 0) c FROM meme_units WHERE status != 'failed' AND source = 'venta'`).get().c || 0;
  const pend = db.prepare(`SELECT COUNT(*) c FROM meme_entitlements e JOIN meme_units u ON u.id = e.unit_id
                           WHERE e.qty_used < e.qty_total AND u.status != 'failed'`).get().c || 0;
  return {
    supply: s,
    config: getConfig(),
    revenueCents: money,
    pendingPerks: pend,
    requests: listRequests('requested').length,
    holders: db.prepare(`SELECT COUNT(DISTINCT LOWER(wallet_address)) c FROM meme_units WHERE status != 'failed'`).get().c || 0
  };
}

function listUnits(limit = 300) {
  return db.prepare(`SELECT * FROM meme_units ORDER BY serial DESC LIMIT ?`).all(limit);
}

// ─── COLA DE MINTEO DE COPIAS EXTRA ──────────────────────────────────────────
// Las unidades con achievement_mint_id se mintean por la cola de logros de siempre.
// Las EXTRA (la 2ª, 3ª… de una misma wallet) no caben en achievement_mints (un
// logro por wallet), así que las mintea esta cola propia.
let isProcessingMeme = false;
async function startMemeQueueWorker() {
  if (isProcessingMeme) return;
  isProcessingMeme = true;
  try {
    const polygon = require('./polygon');
    const nextOf = () => db.prepare(`SELECT * FROM meme_units WHERE status = 'pending' AND achievement_mint_id IS NULL
                                     ORDER BY id ASC LIMIT 1`).get();
    let next = nextOf();
    while (next) {
      console.log(`[MemeQueue] Minteando copia extra del meme #${next.serial} → ${next.wallet_address}`);
      try {
        const r = await polygon.mintNFT({ walletAddress: next.wallet_address, tokenId: MEME.TOKEN_ID, levelName: 'meme_vip' });
        db.prepare(`UPDATE meme_units SET status = 'success', tx_hash = ?, cost_matic = ? WHERE id = ?`)
          .run(r.txHash, r.costMatic || null, next.id);
        console.log(`[MemeQueue] ✅ Meme #${next.serial} minteado. Tx: ${r.txHash}`);
      } catch (err) {
        console.error(`[MemeQueue] ❌ Error en meme #${next.serial}:`, err.message);
        db.prepare(`UPDATE meme_units SET status = 'failed' WHERE id = ?`).run(next.id);
      }
      next = nextOf();
    }
  } catch (e) {
    console.error('[MemeQueue] Error crítico:', e);
  } finally {
    isProcessingMeme = false;
  }
}

function notifyMemeQueue() { setImmediate(startMemeQueueWorker); }

// Las unidades ligadas a achievement_mints copian el estado de su mint (para que
// el panel muestre lo mismo que el museo sin duplicar lógica de minteo). Y de paso
// registra como unidad cualquier meme que haya llegado por otra puerta (premio de
// sorteo, entrega presencial…): así TODO meme que exista cuenta contra las 300.
function syncUnitsFromAchievementMints() {
  try {
    const huerfanos = db.prepare(`SELECT m.id, m.wallet_address, m.status FROM achievement_mints m
                                  LEFT JOIN meme_units u ON u.achievement_mint_id = m.id
                                  WHERE m.achievement_id = ? AND m.status != 'failed' AND u.id IS NULL
                                  ORDER BY m.id ASC`).all(MEME.ACHIEVEMENT_ID);
    huerfanos.forEach(m => {
      const serial = (db.prepare(`SELECT COALESCE(MAX(serial), 0) s FROM meme_units`).get().s || 0) + 1;
      try {
        db.prepare(`INSERT INTO meme_units (serial, wallet_address, achievement_mint_id, source, price_cents, status)
                    VALUES (?, ?, ?, 'externo', 0, ?)`).run(serial, m.wallet_address, m.id, m.status);
      } catch (e) { console.error('[MemeShop] No se pudo registrar unidad externa:', e.message); }
    });
  } catch (_) {}
  try {
    db.prepare(`UPDATE meme_units SET status = (SELECT status FROM achievement_mints WHERE id = meme_units.achievement_mint_id),
                                      tx_hash = (SELECT tx_hash FROM achievement_mints WHERE id = meme_units.achievement_mint_id)
                WHERE achievement_mint_id IS NOT NULL
                  AND status != (SELECT status FROM achievement_mints WHERE id = meme_units.achievement_mint_id)`).run();
  } catch (_) {}
}

function buyWithCorchoCoins(wallet) {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) throw new Error('Wallet no válida');
  const cfg = getConfig();
  if (!cfg.open) throw new Error('La venta del meme está cerrada ahora mismo.');
  const s = supply();
  if (s.left <= 0) throw new Error('Se han agotado las 300 unidades del Meme VIP.');

  const priceCorcho = cfg.priceCorcho || 4000;
  const { spendCorchoCoins } = require('../db/database');

  const spendRes = spendCorchoCoins(wallet, priceCorcho, 'nft_purchase', `Compra de Meme VIP NFT con $CORCHO`, MEME.ACHIEVEMENT_ID);

  if (!spendRes.ok) {
    if (spendRes.error === 'insufficient_balance') {
      throw new Error(`Saldo insuficiente. El Meme VIP cuesta ${priceCorcho} $CORCHO (tienes ${spendRes.currentBalance} $CORCHO).`);
    }
    throw new Error('No se pudo procesar el cobro en $CORCHO.');
  }

  // Ejecutar entrega del Meme
  const sale = sellTo(wallet, { source: 'corcho', priceCents: 0, withPerks: true });
  return { ...sale, newCorchoBalance: spendRes.newBalance, priceCorcho };
}

setTimeout(startMemeQueueWorker, 1500);

module.exports = {
  MEME,
  getConfig, setConfig,
  supply, unitsOfWallet, priceForWallet,
  listPerks, createPerk, updatePerk, deletePerk,
  requestPurchase, cancelRequest, listRequests, pendingRequestOf,
  sellTo, buyWithCorchoCoins,
  moveUnitOnTransfer,
  entitlementsOfWallet, entitlementsOfUnit, usePerk, undoLastUse, pendingDeliveries,
  adminOverview, listUnits, notifyMemeQueue, syncUnitsFromAchievementMints
};

