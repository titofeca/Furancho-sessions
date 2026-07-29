const express = require('express');
const router = express.Router();
const minigames = require('../services/minigames');
const { db } = require('../db/database');
const { requireAuth } = require('./events'); // Assuming it's exported or similar. Wait, I should implement a simple middleware if I can't import it.

const requireWallet = (req, res, next) => {
  const wallet = req.headers['wallet-address'] || req.query.wallet || (req.body && req.body.walletAddress);
  if (!wallet || wallet === 'null' || wallet === 'undefined') {
    return res.status(401).json({ error: 'Debes tener la cuenta iniciada para jugar.' });
  }
  req.walletAddress = wallet;
  next();
};

// ==================== O ENXEBRE ====================

// GET /api/minigames/enxebre/status
router.get('/enxebre/status', requireWallet, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(req.walletAddress, today);
    const { getEconomySettings } = require('../services/corcho');
    const settings = getEconomySettings();
    res.json({
      playedToday: existing && existing.solved !== null ? true : false,
      startedToday: !!existing,
      history: existing || null,
      entryCost: settings.enxebreEntryCost || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/minigames/enxebre/start
router.post('/enxebre/start', requireWallet, (req, res) => {
  try {
    const result = minigames.startEnxebre(req.walletAddress);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
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
        awarded = minigames.recordEnxebrePlay(req.walletAddress, attemptCount, solved);
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

    const hasCunca = active.current_holder.toLowerCase() === req.walletAddress.toLowerCase();
    res.json({ hasCunca, cunca: hasCunca ? active : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/minigames/cunca/drink
router.post('/cunca/drink', requireWallet, (req, res) => {
  try {
    const amount = minigames.drinkCunca(req.walletAddress);
    res.json({ success: true, amount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/minigames/cunca/pass
router.post('/cunca/pass', requireWallet, (req, res) => {
  try {
    const { passCunca } = require('../services/minigames');
    const { toWallet } = req.body;
    if (!toWallet) return res.status(400).json({ error: 'Destino requerido' });
    const result = passCunca(req.walletAddress, toWallet);
    res.json({ success: true, newPot: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/minigames/cunca/start (Admin only)
router.post('/admin/cunca/start', (req, res) => {
  try {
    const { targetWallet } = req.body;
    if (!targetWallet) return res.status(400).json({ error: 'Wallet requerida' });
    minigames.spawnCunca(targetWallet);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== A RULETA DO PULPO ====================

router.get('/ruleta/status', requireWallet, (req, res) => {
  try {
    res.json(minigames.getRuletaStatus(req.walletAddress));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ruleta/spin', requireWallet, (req, res) => {
  try {
    const result = minigames.spinRuleta(req.walletAddress);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== A QUEIMADA ====================

router.get('/queimada/status', requireWallet, (req, res) => {
  try {
    res.json(minigames.getQueimadaStatus(req.walletAddress));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queimada/start', requireWallet, (req, res) => {
  try {
    const result = minigames.startQueimada(req.walletAddress);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/queimada/draw', requireWallet, (req, res) => {
  try {
    const ingredient = minigames.drawIngredient();
    res.json(ingredient);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queimada/resolve', requireWallet, (req, res) => {
  try {
    const { ingredients, totalScore } = req.body;
    if (!Array.isArray(ingredients) || typeof totalScore !== 'number') {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const result = minigames.resolveQueimada(req.walletAddress, ingredients, totalScore);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== NEW MINIGAMES (RASCA, TRAGA, CHAVE, TRIVIAL) ====================
const newMinigames = require('../services/new_minigames');

// 1. Rasca Furancheiro
router.get('/rasca/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'rasca')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/rasca/play', requireWallet, (req, res) => {
  try { res.json(newMinigames.playRasca(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 2. Tragaperras
router.get('/traga/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'traga')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/traga/spin', requireWallet, (req, res) => {
  try { res.json(newMinigames.playTraga(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 3. Chave Virtual
router.get('/chave/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'chave')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/chave/throw', requireWallet, (req, res) => {
  try { res.json(newMinigames.playChave(req.walletAddress, req.body.timing || 0)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 4. Trivial
router.get('/trivial/status', requireWallet, (req, res) => {
  try {
    const status = newMinigames.getStatus(req.walletAddress, 'trivial');
    res.json({ ...status, questions: newMinigames.getTrivialQuestions() });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/trivial/submit', requireWallet, (req, res) => {
  try { res.json(newMinigames.submitTrivial(req.walletAddress, !!req.body.won)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
