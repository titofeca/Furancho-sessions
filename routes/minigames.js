const express = require('express');
const router = express.Router();
const minigames = require('../services/minigames');
const newMinigames = require('../services/new_minigames');
const { db } = require('../db/database');
const { requireAuth } = require('./admin');

const requireWallet = (req, res, next) => {
  const wallet = req.headers['wallet-address'] || req.query.wallet || (req.body && req.body.walletAddress);
  if (!wallet || wallet === 'null' || wallet === 'undefined') {
    return res.status(401).json({ error: 'Debes tener la cuenta iniciada para jugar.' });
  }
  req.walletAddress = wallet;
  next();
};

// ==================== O ENXEBRE ====================
router.get('/enxebre/status', requireWallet, (req, res) => {
  try {
    const today = minigames.getMadridDateStr();
    const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(req.walletAddress, today);
    const { getEconomySettings } = require('../services/corcho');
    const settings = getEconomySettings();
    const vacation = !!settings.vacationMode;
    let prevGuesses = [];
    try { prevGuesses = existing ? JSON.parse(existing.guesses_json || '[]') : []; } catch (_) {}
    const finished = !!(existing && (existing.solved === 1 || prevGuesses.length >= 6 || existing.attempts >= 6));
    res.json({
      playedToday: finished,
      startedToday: !!existing,
      history: existing || null,
      previousGuesses: prevGuesses.map(g => ({ guess: g, result: minigames.checkEnxebreGuess(g) })),
      entryCost: vacation ? 0 : (settings.enxebreEntryCost || 0),
      maxPrize: settings.enxebrePrize1 || 0,
      vacationMode: vacation
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/enxebre/start', requireWallet, (req, res) => {
  try {
    res.json(minigames.startEnxebre(req.walletAddress));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/enxebre/guess', requireWallet, (req, res) => {
  try {
    const { guess } = req.body || {};
    if (!guess || String(guess).trim().length !== 5) {
      return res.status(400).json({ error: 'Introduce una palabra de 5 letras' });
    }
    const out = minigames.submitEnxebreGuess(req.walletAddress, guess);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== A CUNCA QUENTE ====================
router.get('/cunca/status', requireWallet, (req, res) => {
  try {
    const active = minigames.getActiveCunca();
    if (!active) return res.json({ hasCunca: false });
    const hasCunca = active.current_holder.toLowerCase() === req.walletAddress.toLowerCase();
    res.json({ hasCunca, cunca: hasCunca ? active : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cunca/drink', requireWallet, (req, res) => {
  try {
    const amount = minigames.drinkCunca(req.walletAddress);
    res.json({ success: true, amount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/cunca/pass', requireWallet, (req, res) => {
  try {
    const { toWallet } = req.body || {};
    if (!toWallet) return res.status(400).json({ error: 'Destino requerido' });
    const result = minigames.passCunca(req.walletAddress, toWallet);
    res.json({ success: true, newPot: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/admin/cunca/start', requireAuth, (req, res) => {
  try {
    const { targetWallet } = req.body || {};
    if (!targetWallet) return res.status(400).json({ error: 'Wallet requerida' });
    minigames.spawnCunca(targetWallet);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== A RULETA DO PULPO ====================
router.get('/ruleta/status', requireWallet, (req, res) => {
  try { res.json(minigames.getRuletaStatus(req.walletAddress)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ruleta/spin', requireWallet, (req, res) => {
  try { res.json(minigames.spinRuleta(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== A QUEIMADA ====================
router.get('/queimada/status', requireWallet, (req, res) => {
  try { res.json(minigames.getQueimadaStatus(req.walletAddress)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queimada/start', requireWallet, (req, res) => {
  try { res.json(minigames.startQueimada(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/queimada/draw', requireWallet, (req, res) => {
  try { res.json(minigames.drawIngredient(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/queimada/resolve', requireWallet, (req, res) => {
  try { res.json(minigames.resolveQueimada(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== RASCA, TRAGA, CHAVE, TRIVIAL ====================
router.get('/rasca/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'rasca')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/rasca/play', requireWallet, (req, res) => {
  try { res.json(newMinigames.playRasca(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/traga/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'traga')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/traga/spin', requireWallet, (req, res) => {
  try { res.json(newMinigames.playTraga(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/chave/status', requireWallet, (req, res) => {
  try { res.json(newMinigames.getStatus(req.walletAddress, 'chave')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/chave/throw', requireWallet, (req, res) => {
  try { res.json(newMinigames.playChave(req.walletAddress, req.body?.timing ?? 0, req.body?.lateral ?? 0)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/trivial/status', requireWallet, (req, res) => {
  try {
    const status = newMinigames.getStatus(req.walletAddress, 'trivial');
    res.json({ ...status, questions: newMinigames.getTrivialQuestions(req.walletAddress) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/trivial/start', requireWallet, (req, res) => {
  try { res.json(newMinigames.startTrivialSession(req.walletAddress)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/trivial/check', requireWallet, (req, res) => {
  try { res.json(newMinigames.checkTrivialSingleAnswer(req.walletAddress, Number(req.body?.questionIndex || 0), Number(req.body?.selectedIdx ?? -1))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/trivial/submit', requireWallet, (req, res) => {
  try { res.json(newMinigames.submitTrivial(req.walletAddress, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
