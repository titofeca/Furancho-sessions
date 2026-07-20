const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const achievements = require('../services/achievements');
const {
  claimAchievement, getAchievementMint, getWalletAchievementMints,
  getHiddenLockedAchievementIds, setAchievementLockedVisibility
} = require('../db/database');
const { notifyAchievementQueue } = require('../services/polygon');
const { requireAuth } = require('./admin'); // gestión de logros: solo admin

const ETH = /^0x[a-fA-F0-9]{40}$/;

const claimLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Demasiadas peticiones, ho. Espera un minuto.' },
  standardHeaders: true, legacyHeaders: false
});

// GET /api/achievements/catalog — lista simple de logros (para el desplegable del admin).
router.get('/catalog', (req, res) => {
  res.json(achievements.list().map(a => ({ id: a.id, name: a.name, tokenId: a.tokenId })));
});

// GET /api/achievements/status?wallet=0x... — catálogo de logros NFT + estado por wallet.
router.get('/status', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !ETH.test(wallet)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    const mints = {};
    getWalletAchievementMints(wallet).forEach(m => { mints[m.achievement_id] = m; });
    const hidden = new Set(getHiddenLockedAchievementIds());
    const items = achievements.list().map(a => {
      const m = mints[a.id];
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        story: a.story || null,   // historia larga opcional (detalle del museo)
        image: a.image,   // ya viene normalizada desde el catálogo
        tokenId: a.tokenId,
        edition: a.edition || null,
        ruleType: a.rule ? a.rule.type : null,   // visit_on_date | campaign_visits | raffle_only | referrals | vip_bookings
        ruleDate: a.rule ? (a.rule.type === 'referrals' ? String(a.rule.requiredCount || 10) : a.rule.date) : null,
        unlocked: achievements.walletUnlocked(wallet, a),
        claimStatus: m ? m.status : null,   // null = sin reclamar; 'pending'|'success'|'failed'
        txHash: m ? m.tx_hash : null,
        serial: m ? m.mint_serial : null
      };
    })
    // Los logros que el admin marcó como ocultos NO se muestran hasta conseguirlos;
    // los ya conseguidos/reclamados se ven siempre.
    .filter(it => it.unlocked || it.claimStatus || !hidden.has(it.id));
    res.json({ achievements: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/achievements/claim — el cliente convierte un logro desbloqueado en NFT.
// Body: { walletAddress, achievementId }
router.post('/claim', claimLimiter, (req, res) => {
  const { walletAddress, achievementId } = req.body;
  if (!walletAddress || !ETH.test(walletAddress)) return res.status(400).json({ error: 'Wallet no válida' });
  const a = achievements.getById(achievementId);
  if (!a) return res.status(404).json({ error: 'Logro no encontrado' });
  try {
    // El meme NO se reclama: se compra (o lo regala el local). Su puerta es
    // /api/meme, que es donde se controlan las 300 unidades y el precio.
    if (a.id === 'meme_vip') {
      return res.status(403).json({ error: 'El meme no se reclama, ho: se compra. Dale al botón de comprar y págalo en la barra.' });
    }
    // Verificación SERVIDOR de la regla (no se fía del cliente): hay que haber asistido.
    if (!achievements.walletUnlocked(walletAddress, a)) {
      return res.status(403).json({ error: 'Aún no has desbloqueado este logro, ho. Hay que asistir al evento.' });
    }
    const existing = getAchievementMint(walletAddress, a.id);
    if (existing) {
      return res.json({ success: true, alreadyClaimed: true, status: existing.status, achievementId: a.id });
    }
    
    // Validar límite máximo (maxSupply)
    if (a.maxSupply) {
      const { db } = require('../db/database');
      const countQuery = db.prepare(`SELECT COUNT(*) as count FROM achievement_mints WHERE achievement_id = ? AND status != 'failed'`).get(a.id);
      const currentSupply = countQuery ? countQuery.count : 0;
      if (currentSupply >= a.maxSupply) {
        return res.status(400).json({ error: `Se ha alcanzado el límite máximo de ${a.maxSupply} unidades para este logro.` });
      }
    }
    // Logros de campaña (Reto de los 5) y reservas VIP: requieren aprobación admin antes de mintear
    // (anti-trampa / control de gas). No entran directos a la cola.
    if (a.rule && (a.rule.type === 'campaign_visits' || a.rule.type === 'vip_bookings')) {
      claimAchievement(walletAddress, a.id, a.tokenId, 'pending_approval');
      return res.json({ success: true, status: 'pending_approval', achievementId: a.id });
    }
    claimAchievement(walletAddress, a.id, a.tokenId);
    notifyAchievementQueue();
    res.json({ success: true, status: 'pending', achievementId: a.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GESTIÓN DESDE EL PANEL (admin) ──────────────────────────────────────────

// GET /api/achievements/admin/list — catálogo completo con marca de cuáles se
// pueden borrar (los creados desde el panel) y el próximo token libre.
router.get('/admin/list', requireAuth, (req, res) => {
  try {
    const hidden = new Set(getHiddenLockedAchievementIds());
    res.json({
      achievements: achievements.list().map(a => ({
        id: a.id, name: a.name, description: a.description, image: a.image,
        tokenId: a.tokenId, edition: a.edition || null,
        ruleType: a.rule ? a.rule.type : null,
        ruleDate: a.rule ? (a.rule.type === 'visit_on_date' ? a.rule.date : (a.rule.type === 'campaign_visits' ? String(a.rule.requiredVisits) : (a.rule.type === 'vip_bookings' ? String(a.rule.requiredCount) : (a.rule.type === 'referrals' ? String(a.rule.requiredCount) : null)))) : null,
        custom: !!a.custom,
        // hiddenLocked=true → los clientes NO lo ven hasta conseguirlo (por defecto se ve).
        hiddenLocked: hidden.has(a.id)
      })),
      nextTokenId: achievements.nextTokenId()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/achievements/admin/:id/visibility — el admin decide, POR LOGRO, si se ve
// en el museo (sombreado) ANTES de conseguirlo. Body: { visible: true|false }.
router.put('/admin/:id/visibility', requireAuth, (req, res) => {
  try {
    const visible = req.body.visible !== false;
    setAchievementLockedVisibility(req.params.id, visible);
    res.json({ success: true, id: req.params.id, visible });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/achievements/admin/create — crea un logro nuevo desde el panel.
// Body: { name, description, image, edition, ruleDate, tokenId?, ruleType? }
// ruleType: 'visit_on_date' (por defecto) o 'raffle_only' (solo se otorga como
// premio de sorteo, no autoreclamable desde el museo).
router.post('/admin/create', requireAuth, (req, res) => {
  try {
    const { name, description, image, edition, ruleDate, tokenId, ruleType } = req.body;
    const created = achievements.createCustom({ name, description, image, edition, ruleDate, tokenId, ruleType });
    res.json({ success: true, achievement: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/achievements/admin/raffle-only — logros que se entregan como premio
// de sorteo (para el desplegable al programar un sorteo NFT).
router.get('/admin/raffle-only', requireAuth, (req, res) => {
  try { res.json({ list: achievements.listRaffleOnly() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/achievements/admin/:id — edita un logro creado desde el panel.
// Body: cualquiera de { name, description, image, edition, ruleType, ruleDate }.
// El token_id (identidad on-chain) no se cambia. No afecta a NFTs ya minteados.
router.patch('/admin/:id', requireAuth, (req, res) => {
  try {
    const { name, description, image, edition, ruleType, ruleDate } = req.body;
    const updated = achievements.updateCustom(req.params.id, { name, description, image, edition, ruleType, ruleDate });
    res.json({ success: true, achievement: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/achievements/admin/:id — borra un logro creado desde el panel
// (nunca los del código). No afecta a NFTs ya minteados en wallets.
router.delete('/admin/:id', requireAuth, (req, res) => {
  try {
    const ok = achievements.deleteCustom(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Logro no encontrado' });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
