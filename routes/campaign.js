// Endpoints públicos (solo lectura) de la campaña "Reto de los 5" para la app del cliente.
const express = require('express');
const router = express.Router();
const campaign = require('../services/campaign');

const ETH = /^0x[a-fA-F0-9]{40}$/;

// GET /api/campaign/progress?wallet=0x... — progreso del cliente en el Reto de los 5.
router.get('/progress', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !ETH.test(wallet)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    res.json(campaign.getProgress(wallet));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
