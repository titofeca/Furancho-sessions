const express = require('express');
const router = express.Router();
const { db, getActiveEventWindow } = require('../db/database');

// POST /api/inbox/send-dm — cliente envía un mensaje privado (DM) al patrón
router.post('/send-dm', (req, res) => {
  const { walletAddress, body } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'El cuerpo del mensaje no puede estar vacío' });
  }

  try {
    db.prepare(`
      INSERT INTO client_messages (wallet_address, body)
      VALUES (?, ?)
    `).run(walletAddress.toLowerCase(), body.trim());
    res.json({ success: true });
  } catch (e) {
    console.error('Error in POST /send-dm:', e.message);
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  }
});

// GET /api/inbox/board — obtener las últimas 50 publicaciones del muro público
router.get('/board', (req, res) => {
  try {
    const posts = db.prepare(`
      SELECT id, wallet_address, display_name, body, created_at
      FROM board_posts
      ORDER BY id DESC LIMIT 50
    `).all();
    res.json(posts);
  } catch (e) {
    console.error('Error in GET /board:', e.message);
    res.status(500).json({ error: 'Error al obtener publicaciones del muro' });
  }
});

// POST /api/inbox/board/post — publicar un mensaje en el muro público
// SOLO disponible para clientes actualmente fichados (entrada registrada y salida no marcada hoy)
router.post('/board/post', (req, res) => {
  const { walletAddress, body } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'El cuerpo del mensaje no puede estar vacío' });
  }

  try {
    // 1. Validar que la wallet tiene una sesión activa hoy
    const now = new Date();
    const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const yyyy = madridTime.getFullYear();
    const mm = String(madridTime.getMonth() + 1).padStart(2, '0');
    const dd = String(madridTime.getDate()).padStart(2, '0');
    const todayMadrid = `${yyyy}-${mm}-${dd}`;

    const session = db.prepare(`
      SELECT id, entry_time FROM sessions
      WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL
      ORDER BY entry_time DESC LIMIT 1
    `).get(walletAddress);

    if (!session) {
      return res.status(403).json({ error: 'Fichaje requerido: debes haber fichado la entrada hoy para publicar en el muro en vivo, ho.' });
    }

    // Comprobar que la sesión de entrada fue hoy en hora de Madrid
    const entryMadrid = new Date(new Date(session.entry_time.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const entryMadridDate = `${entryMadrid.getFullYear()}-${String(entryMadrid.getMonth() + 1).padStart(2, '0')}-${String(entryMadrid.getDate()).padStart(2, '0')}`;

    if (entryMadridDate !== todayMadrid) {
      return res.status(403).json({ error: 'Fichaje caducado: tu sesión es de un día anterior. Ficha entrada de nuevo.' });
    }

    // 2. Determinar el nombre visible (Alias de mesa VIP completada hoy, o alias del nivel)
    let displayName = 'Furancheiro';

    // ¿Tiene una reserva VIP completada hoy?
    const win = getActiveEventWindow();
    if (win && win.event) {
      const vip = db.prepare(`
        SELECT alias FROM vip_reservations
        WHERE LOWER(wallet_address) = LOWER(?) AND event_id = ? AND status = 'completed'
      `).get(walletAddress, win.event.id);
      
      if (vip && vip.alias) {
        displayName = `⭐ Mesa: ${vip.alias}`;
      }
    }

    // Si no es VIP, buscar su nivel actual
    if (displayName === 'Furancheiro') {
      const mint = db.prepare(`
        SELECT level_name FROM mints
        WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'
        ORDER BY level DESC LIMIT 1
      `).get(walletAddress);
      
      if (mint && mint.level_name) {
        displayName = `${mint.level_name} (${walletAddress.slice(0, 6)}...)`;
      } else {
        displayName = `Cautivo (${walletAddress.slice(0, 6)}...)`;
      }
    }

    // 3. Insertar publicación
    db.prepare(`
      INSERT INTO board_posts (wallet_address, display_name, body)
      VALUES (?, ?, ?)
    `).run(walletAddress.toLowerCase(), displayName, body.trim());

    res.json({ success: true, displayName });
  } catch (e) {
    console.error('Error in POST /board/post:', e.message);
    res.status(500).json({ error: 'Error al publicar en el muro' });
  }
});

module.exports = router;
