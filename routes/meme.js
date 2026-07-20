// ─────────────────────────────────────────────────────────────────────────────
//  TIENDA DEL MEME — API. El cliente pide comprar desde el museo; el admin cobra
//  en el local y confirma la venta. Toda la lógica vive en services/memeShop.js
//  (fuente única): aquí solo hay puerta de entrada y validación.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const shop = require('../services/memeShop');
const { requireAuth } = require('./admin');

const ETH = /^0x[a-fA-F0-9]{40}$/;

const buyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Demasiadas peticiones, ho. Espera un minuto.' },
  standardHeaders: true, legacyHeaders: false
});

// ─── CLIENTE ─────────────────────────────────────────────────────────────────

// GET /api/meme/status?wallet=0x… — qué ve el cliente: cuántos quedan de los 300,
// cuánto le costaría el suyo, los que ya tiene y lo que le queda por consumir.
router.get('/status', (req, res) => {
  const { wallet } = req.query;
  try {
    const cfg = shop.getConfig();
    const s = shop.supply();
    // La imagen sale del catálogo de logros (fuente única): así, cuando se sube
    // un arte nuevo desde el panel, cambia en TODAS partes a la vez.
    let image = '/assets/nft_meme_vip.jpg';
    try {
      const a = require('../services/achievements').getById(shop.MEME.ACHIEVEMENT_ID);
      if (a && a.image) image = a.image;
    } catch (_) {}
    const out = {
      image,
      maxSupply: shop.MEME.MAX_SUPPLY,   // 300, siempre. No es configurable.
      sold: s.sold,
      left: s.left,
      open: cfg.open && s.left > 0,
      note: cfg.note,
      priceCents: cfg.priceCents,
      perks: shop.listPerks(true).map(p => ({ emoji: p.emoji, label: p.label, qty: p.qty, kind: p.kind }))
    };
    if (wallet && ETH.test(wallet)) {
      const price = shop.priceForWallet(wallet);
      const req0 = shop.pendingRequestOf(wallet);
      out.mine = {
        owned: price.owned,
        nextIndex: price.index,
        nextPriceCents: price.cents,
        multiplier: price.multiplier,
        units: shop.unitsOfWallet(wallet).map(u => ({ serial: u.serial, status: u.status, at: u.created_at })),
        entitlements: shop.entitlementsOfWallet(wallet).map(e => ({
          id: e.id, emoji: e.emoji, label: e.label, kind: e.kind,
          left: Math.max(0, e.qty_total - e.qty_used), total: e.qty_total, serial: e.serial
        })),
        pendingRequest: req0 ? { id: req0.id, priceCents: req0.price_cents, at: req0.created_at } : null
      };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/meme/request — el cliente pulsa "Comprar". No cobra nada aquí: deja
// la solicitud para pagar en el local. El admin la confirma al cobrar.
router.post('/request', buyLimiter, (req, res) => {
  const { walletAddress, note } = req.body;
  if (!walletAddress || !ETH.test(walletAddress)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    const r = shop.requestPurchase(walletAddress, note);
    res.json({ success: true, alreadyRequested: r.alreadyRequested, request: r.request });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/meme/cancel — el cliente se arrepiente antes de pagar.
router.post('/cancel', buyLimiter, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !ETH.test(walletAddress)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    const p = shop.pendingRequestOf(walletAddress);
    if (!p) return res.json({ success: true, nothing: true });
    shop.cancelRequest(p.id);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

// GET /api/meme/admin/overview — panel: existencias, caja, solicitudes y pendientes.
router.get('/admin/overview', requireAuth, (req, res) => {
  try {
    shop.syncUnitsFromAchievementMints();
    res.json({
      ...shop.adminOverview(),
      perks: shop.listPerks(false),
      requests: shop.listRequests('requested'),
      pending: shop.pendingDeliveries(),
      units: shop.listUnits(50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/meme/admin/config — precio base, multiplicador, venta abierta y nota.
// NO existe forma de tocar las 300 unidades: no se lee del cuerpo ni se guarda.
router.put('/admin/config', requireAuth, (req, res) => {
  try {
    const { priceCents, multiplier, open, note } = req.body;
    res.json({ success: true, config: shop.setConfig({ priceCents, multiplier, open, note }), supply: shop.supply() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Qué incluye el meme (catálogo). Cambiarlo NO altera lo ya vendido.
router.post('/admin/perks', requireAuth, (req, res) => {
  try { res.json({ success: true, perk: shop.createPerk(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/admin/perks/:id', requireAuth, (req, res) => {
  try { res.json({ success: true, perk: shop.updatePerk(parseInt(req.params.id, 10), req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/perks/:id', requireAuth, (req, res) => {
  try {
    const ok = shop.deletePerk(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'No encontrado' });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/meme/admin/sell — CONFIRMA la venta (ya cobrada en el local) o entrega
// un meme de regalo. Body: { walletAddress, purchaseId?, priceCents?, source?, withPerks? }
router.post('/admin/sell', requireAuth, (req, res) => {
  const { walletAddress, purchaseId, priceCents, source, withPerks } = req.body;
  if (!walletAddress || !ETH.test(walletAddress)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    const out = shop.sellTo(walletAddress, {
      purchaseId: purchaseId || null,
      source: source === 'regalo' ? 'regalo' : 'venta',
      priceCents: (priceCents === undefined || priceCents === null || priceCents === '') ? null : parseInt(priceCents, 10),
      withPerks: withPerks !== false
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/meme/admin/requests/:id/reject — descartar una solicitud sin vender.
router.post('/admin/requests/:id/reject', requireAuth, (req, res) => {
  try { res.json({ success: shop.cancelRequest(parseInt(req.params.id, 10)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/meme/admin/wallet/:wallet — ficha del cliente para atenderlo en barra.
router.get('/admin/wallet/:wallet', requireAuth, (req, res) => {
  const w = req.params.wallet;
  if (!ETH.test(w)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    res.json({
      wallet: w,
      units: shop.unitsOfWallet(w),
      entitlements: shop.entitlementsOfWallet(w),
      price: shop.priceForWallet(w),
      request: shop.pendingRequestOf(w)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/meme/admin/entitlement/:id/use — entregar/consumir una unidad de lo
// incluido (una tapa, la camiseta cuando llega el stock…).
router.post('/admin/entitlement/:id/use', requireAuth, (req, res) => {
  try { res.json({ success: true, entitlement: shop.usePerk(parseInt(req.params.id, 10), req.body.qty || 1, req.body.note) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/meme/admin/entitlement/:id/undo — deshacer la última entrega.
router.post('/admin/entitlement/:id/undo', requireAuth, (req, res) => {
  try { res.json({ success: true, entitlement: shop.undoLastUse(parseInt(req.params.id, 10)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
