const express = require('express');
const router = express.Router();
const { getEvents, toggleRsvp, getRsvpStatus } = require('../db/database');
const { requireAuth } = require('./admin');
const { getSessionAnalytics } = require('../db/database');

// GET /api/events — lista de eventos con conteo de asistentes (público)
router.get('/', (req, res) => {
  try {
    res.json(getEvents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/events/rsvp — apuntarse o desapuntarse a un evento
router.post('/rsvp', (req, res) => {
  const { eventId, walletAddress } = req.body;
  if (!eventId || !walletAddress) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const attending = toggleRsvp(parseInt(eventId), walletAddress);
    res.json({ success: true, attending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/events/my-rsvps?wallet=0x...
router.get('/my-rsvps', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    res.json(getRsvpStatus(wallet));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/events/analytics — para el admin
router.get('/analytics', requireAuth, (req, res) => {
  try {
    res.json(getSessionAnalytics());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
