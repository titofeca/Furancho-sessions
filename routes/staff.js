// Acceso ligero para CAMAREROS — página /staff. Permite que cualquier camarero
// que trabaje esa noche, desde su propio móvil, escanee el "ID Socio (QR)" de un
// cliente y le fiche la ENTRADA para que participe en los sorteos. AISLADO del panel
// admin: el código de camarero solo desbloquea el check-in, nunca da acceso admin.
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const router = express.Router();

// Código que comparten los camareros esa noche. El admin lo configura en Railway
// (STAFF_CODE) y lo ve/comparte desde el panel. Default solo para desarrollo.
const STAFF_CODE = process.env.STAFF_CODE || 'camareros';

// Generoso pero acotado: un camarero ficha en ráfaga al abrir el local.
const staffLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  message: { error: 'Demasiadas peticiones, espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Comparación en tiempo constante para no filtrar el código por timing.
function codeOk(code) {
  if (!code || typeof code !== 'string') return false;
  const a = Buffer.from(code);
  const b = Buffer.from(STAFF_CODE);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireStaff(req, res, next) {
  if (codeOk(req.headers['x-staff-code'])) return next();
  return res.status(401).json({ error: 'Código de camarero no válido' });
}

// POST /api/staff/login — valida el código para desbloquear la página en ese móvil.
router.post('/login', staffLimiter, (req, res) => {
  const { code } = req.body || {};
  if (!codeOk(code)) return res.status(401).json({ error: 'Código incorrecto, ho.' });
  res.json({ success: true });
});

// POST /api/staff/checkin — el camarero ficha la ENTRADA del cliente escaneado.
// Reusa EXACTAMENTE la misma lógica de fichaje que /entry y /admin-checkin.
router.post('/checkin', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const { performCheckin } = require('./mint');
    return res.json(performCheckin(walletAddress, req.ip));
  } catch (e) {
    console.error('Error en /staff/checkin:', e.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

module.exports = router;
