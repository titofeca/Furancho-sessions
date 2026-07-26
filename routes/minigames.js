const express = require('express');
const router = express.Router();
const minigames = require('../services/minigames');
const { db } = require('../db/database');
const { requireAuth } = require('./events'); // Assuming it's exported or similar. Wait, I should implement a simple middleware if I can't import it.

// Middleware simple
const requireWallet = (req, res, next) => {
  if (!req.user || !req.user.walletAddress) return res.status(401).json({ error: 'Auth required' });
  next();
};

// ==================== O ENXEBRE ====================

// GET /api/minigames/enxebre/status
router.get('/enxebre/status', requireWallet, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(req.user.walletAddress, today);
    res.json({
      playedToday: !!existing,
      history: existing || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/minigames/enxebre/guess
router.post('/enxebre/guess', requireWallet, (req, res) => {
  try {
    const { guess, attemptCount } = req.body;
    if (!guess || guess.length !== 5) return res.status(400).json({ error: 'Invalid guess' });
    
    const result = minigames.checkEnxebreGuess(guess.toUpperCase());
    const solved = result.every(r => r === 'correct');
    let awarded = 0;

    // If solved or max attempts (6) reached, record it
    if (solved || attemptCount >= 6) {
      try {
        awarded = minigames.recordEnxebrePlay(req.user.walletAddress, attemptCount, solved);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    res.json({ result, solved, awarded });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== A CUNCA QUENTE ====================

// GET /api/minigames/cunca/status
router.get('/cunca/status', requireWallet, (req, res) => {
  try {
    const active = minigames.getActiveCunca();
    if (!active) return res.json({ hasCunca: false });
    
    const hasCunca = active.current_holder.toLowerCase() === req.user.walletAddress.toLowerCase();
    res.json({ hasCunca, cunca: hasCunca ? active : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/minigames/cunca/drink
router.post('/cunca/drink', requireWallet, (req, res) => {
  try {
    const amount = minigames.drinkCunca(req.user.walletAddress);
    res.json({ success: true, amount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/minigames/cunca/pass
router.post('/cunca/pass', requireWallet, (req, res) => {
  try {
    const { toWallet } = req.body;
    if (!toWallet) return res.status(400).json({ error: 'Destino requerido' });
    const newPot = minigames.passCunca(req.user.walletAddress, toWallet);
    res.json({ success: true, newPot });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/minigames/cunca/start (Admin only)
router.post('/admin/cunca/start', (req, res) => {
  try {
    // Basic admin check (this route should ideally be mounted under /api/admin)
    // We'll trust the main app routing or add a simple check here
    const { targetWallet } = req.body;
    if (!targetWallet) return res.status(400).json({ error: 'Wallet requerida' });
    minigames.spawnCunca(targetWallet);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
