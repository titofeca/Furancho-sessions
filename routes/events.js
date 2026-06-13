const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getEvents, toggleRsvp, getRsvpStatus,
        createVipReservation, getVipReservations, getVipReservation,
        getVipCapacity, updateVipStatus, setVipMax,
        getSessionAnalytics,
        createEvent, updateEvent, deleteEvent, getAllEvents } = require('../db/database');
const { requireAuth } = require('./admin');
const { sendVipRequestEmail } = require('../services/notifications');

// Rate limiters
const rsvpLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: { error: 'Demasiadas peticiones. Espéra un momento, ho.' }, standardHeaders: true, legacyHeaders: false });
const reactLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Demasiadas reacciones. Calmía, ho.' }, standardHeaders: true, legacyHeaders: false });

// Alérgenos de declaración obligatoria UE (Reglamento 1169/2011, Anexo II).
// El RSVP es público: hay que sanear lo que entra para no guardar/pintar texto arbitrario (XSS).
const VALID_ALLERGENS = ['gluten','crustaceos','huevos','pescado','cacahuetes','soja','lacteos','frutos_secos','apio','mostaza','sesamo','sulfitos','altramuces','moluscos'];
function sanitizeAllergens(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.trim() === 'tododo') return 'tododo';
  const clean = raw.split(',').map(s => s.trim()).filter(id => VALID_ALLERGENS.includes(id));
  return clean.length ? clean.join(',') : null;
}

// GET /api/events — lista de eventos con conteo de asistentes (público)
router.get('/', (req, res) => {
  try {
    res.json(getEvents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/events/rsvp — apuntarse o desapuntarse a un evento
router.post('/rsvp', rsvpLimiter, (req, res) => {
  const { eventId, walletAddress, allergens } = req.body;
  if (!eventId || !walletAddress) return res.status(400).json({ error: 'Faltan datos' });
  if (!/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) return res.status(400).json({ error: 'Wallet no válida' });
  try {
    const { toggleRsvp } = require('../db/database');
    const attending = toggleRsvp(parseInt(eventId), walletAddress, sanitizeAllergens(allergens));
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

// GET /api/events/all — todos los eventos incluyendo inactivos (admin)
router.get('/all', requireAuth, (req, res) => {
  try { res.json(getAllEvents()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events — crear nuevo evento (admin)
router.post('/', requireAuth, (req, res) => {
  const { date, title, description, startTime, endTime } = req.body;
  if (!date) return res.status(400).json({ error: 'Falta la fecha' });
  try {
    const id = createEvent({ date, title, description, startTime, endTime });
    res.json({ success: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/events/:id — editar evento (admin)
router.patch('/:id', requireAuth, (req, res) => {
  const { title, description, date, active, startTime, endTime } = req.body;
  try {
    updateEvent(parseInt(req.params.id), { title, description, date, active, startTime, endTime });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/events/:id — desactivar evento (admin)
router.delete('/:id', requireAuth, ({ params }, res) => {
  try {
    deleteEvent(parseInt(params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/events/:id/tapas — tapas de un evento (público)
router.get('/:id/tapas', (req, res) => {
  try {
    const { db } = require('../db/database');
    const rows = db.prepare(`SELECT id, name, description, allergens, sort_order FROM tapas WHERE event_id = ? ORDER BY sort_order ASC, id ASC`).all(parseInt(req.params.id));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events/:id/tapas — añadir tapa (admin)
router.post('/:id/tapas', requireAuth, (req, res) => {
  const eventId = parseInt(req.params.id);
  const { name, description, allergens } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const { db } = require('../db/database');
    const count = db.prepare(`SELECT COUNT(*) as c FROM tapas WHERE event_id = ?`).get(eventId).c;
    if (count >= 5) return res.status(400).json({ error: 'Máximo 5 tapas por evento' });
    const order = db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 as next FROM tapas WHERE event_id = ?`).get(eventId).next;
    const result = db.prepare(`INSERT INTO tapas (event_id, name, description, allergens, sort_order) VALUES (?, ?, ?, ?, ?)`).run(eventId, name.trim(), (description||'').trim(), (allergens||''), order);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/events/tapas/:tapaid — editar tapa (admin)
router.patch('/tapas/:tapaid', requireAuth, (req, res) => {
  const { name, description, allergens } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const { db } = require('../db/database');
    db.prepare(`UPDATE tapas SET name=?, description=?, allergens=? WHERE id=?`).run(name.trim(), (description||'').trim(), (allergens||''), parseInt(req.params.tapaid));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events/tapas/reorder — reordenar tapas (admin)
router.post('/tapas/reorder', requireAuth, (req, res) => {
  const { items } = req.body; // [{id, sort_order}, ...]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser array' });
  try {
    const { db } = require('../db/database');
    const stmt = db.prepare(`UPDATE tapas SET sort_order=? WHERE id=?`);
    const tx = db.transaction(() => items.forEach(item => stmt.run(item.sort_order, item.id)));
    tx();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/events/tapas/:tapaid — eliminar tapa (admin)
router.delete('/tapas/:tapaid', requireAuth, (req, res) => {
  try {
    const { db } = require('../db/database');
    db.prepare(`DELETE FROM tapas WHERE id=?`).run(parseInt(req.params.tapaid));
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
