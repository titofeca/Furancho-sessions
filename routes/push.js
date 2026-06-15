const express = require('express');
const router = express.Router();
const { savePushSubscription } = require('../db/database');
const { VAPID_PUBLIC } = require('../services/push');

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});

// POST /api/push/subscribe
router.post('/subscribe', (req, res) => {
  const { subscription, walletAddress, channels } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  try {
    savePushSubscription(walletAddress, subscription, channels || null);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
