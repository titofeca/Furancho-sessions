const express = require('express');
const router = express.Router();
const { getEvents, toggleRsvp, getRsvpStatus,
        createVipReservation, getVipReservations, getVipReservation,
        getVipCapacity, updateVipStatus, setVipMax,
        getSessionAnalytics } = require('../db/database');
const { requireAuth } = require('./admin');
const { sendVipRequestEmail } = require('../services/notifications');

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

// GET /api/events/vip/my-reservations?wallet=0x... — reservas del cliente
router.get('/vip/my-reservations', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Falta wallet' });
  try {
    const { db } = require('../db/database');
    const rows = db.prepare(`
      SELECT r.id, r.event_id, r.group_size, r.status, r.notes, r.created_at,
             e.event_date, e.title as event_title
      FROM vip_reservations r
      JOIN events e ON r.event_id = e.id
      WHERE r.wallet_address = ?
      ORDER BY e.event_date ASC
    `).all(wallet);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/events/:id/vip — capacidad VIP de un evento (público)
router.get('/:id/vip', (req, res) => {
  try {
    res.json(getVipCapacity(parseInt(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events/vip — crear reserva VIP (notifica por email a los admins)
router.post('/vip', async (req, res) => {
  const { eventId, walletAddress, phone, groupSize, notes } = req.body;
  if (!eventId || !walletAddress || !phone || !groupSize)
    return res.status(400).json({ error: 'Faltan datos' });
  const phoneClean = phone.replace(/\s/g,'');
  if (!/^[+]?[\d]{9,15}$/.test(phoneClean))
    return res.status(400).json({ error: 'Teléfono no válido' });
  try {
    const events = getEvents();
    const ev = events.find(e => e.id === parseInt(eventId));
    const cap = createVipReservation({
      eventId: parseInt(eventId),
      walletAddress,
      phone: phoneClean,
      groupSize: parseInt(groupSize),
      notes
    });
    // Notificación email a admins (sin bloquear la respuesta)
    sendVipRequestEmail({
      phone: phoneClean,
      groupSize: parseInt(groupSize),
      notes,
      eventTitle: ev ? ev.title : `Evento #${eventId}`,
      eventDate: ev ? ev.event_date : ''
    }).catch(() => {});
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
    const reservation = getVipReservation(parseInt(req.params.id));
    updateVipStatus(parseInt(req.params.id), status);
    res.json({
      success: true,
      phone: reservation?.phone,
      groupSize: reservation?.group_size,
      eventTitle: reservation?.event_title
    });
    // Notificar al cliente vía SSE si está conectado
    if (reservation?.wallet_address) {
      try {
        const { broadcast } = require('./raffle');
        broadcast('vip_status', {
          eventId: reservation.event_id,
          status,
          eventTitle: reservation.event_title
        }, reservation.wallet_address);
      } catch(_) {}
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/events/:id/vip/capacity — admin ajusta plazas VIP disponibles
router.patch('/:id/vip/capacity', requireAuth, (req, res) => {
  const { vipMax } = req.body;
  if (vipMax === undefined || isNaN(parseInt(vipMax)))
    return res.status(400).json({ error: 'Falta vipMax' });
  try {
    const cap = setVipMax(parseInt(req.params.id), parseInt(vipMax));
    res.json({ success: true, capacity: cap });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
