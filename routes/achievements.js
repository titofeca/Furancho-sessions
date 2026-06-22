const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const achievements = require('../services/achievements');
const {
  claimAchievement, getAchievementMint, getWalletAchievementMints
} = require('../db/database');
const { notifyAchievementQueue } = require('../services/polygon');

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
    const items = achievements.list().map(a => {
      const m = mints[a.id];
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        image: `/assets/${a.image}`,
        tokenId: a.tokenId,
        unlocked: achievements.walletUnlocked(wallet, a),
        claimStatus: m ? m.status : null,   // null = sin reclamar; 'pending'|'success'|'failed'
        txHash: m ? m.tx_hash : null
      };
    });
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
    // Verificación SERVIDOR de la regla (no se fía del cliente): hay que haber asistido.
    if (!achievements.walletUnlocked(walletAddress, a)) {
      return res.status(403).json({ error: 'Aún no has desbloqueado este logro, ho. Hay que asistir al evento.' });
    }
    const existing = getAchievementMint(walletAddress, a.id);
    if (existing) {
      return res.json({ success: true, alreadyClaimed: true, status: existing.status, achievementId: a.id });
    }
    claimAchievement(walletAddress, a.id, a.tokenId);
    notifyAchievementQueue();
    res.json({ success: true, status: 'pending', achievementId: a.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
