const express = require('express');
const router = express.Router();
const { getEvents, toggleRsvp, getRsvpStatus,
        createVipReservation, getVipReservations, getVipCapacity, updateVipStatus,
        getSessionAnalytics } = require('../db/database');
const { requireAuth } = require('./admin');

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

// GET /api/events/:id/vip — capacidad VIP de un evento (público)
router.get('/:id/vip', (req, res) => {
  try {
    res.json(getVipCapacity(parseInt(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events/vip — crear reserva VIP
router.post('/vip', (req, res) => {
  const { eventId, walletAddress, phone, groupSize } = req.body;
  if (!eventId || !walletAddress || !phone || !groupSize)
    return res.status(400).json({ error: 'Faltan datos' });
  const phoneClean = phone.replace(/\s/g,'');
  if (!/^[+]?[\d]{9,15}$/.test(phoneClean))
    return res.status(400).json({ error: 'Teléfono no válido' });
  try {
    const cap = createVipReservation({ eventId: parseInt(eventId), walletAddress, phone: phoneClean, groupSize: parseInt(groupSize) });
    res.json({ success: true, capacity: cap });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/events/:id/vip/reservations — admin ve todas las reservas
router.get('/:id/vip/reservations', requireAuth, (req, res) => {
  try {
    const reservations = getVipReservations(parseInt(req.params.id));
    const cap = getVipCapacity(parseInt(req.params.id));
    res.json({ reservations, capacity: cap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/events/vip/:id — admin confirma/cancela reserva
router.patch('/vip/:id', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['confirmed','cancelled','pending'].includes(status))
    return res.status(400).json({ error: 'Estado no válido' });
  try {
    updateVipStatus(parseInt(req.params.id), status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
