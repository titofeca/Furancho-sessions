require('dotenv').config();

// Capturar errores no manejados para que aparezcan en logs de Railway
process.on('uncaughtException',  (e) => console.error('[CRASH] uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[CRASH] unhandledRejection:', e?.stack || e));

const express = require('express');
const cors = require('cors');
const path = require('path');
const qrRoutes = require('./routes/qr');
const raffleRoutes = require('./routes/raffle');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway actúa como proxy — necesario para que rate-limit y req.ip funcionen correctamente
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas API
app.use('/api/mint', require('./routes/mint'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/qr', qrRoutes);
app.use('/api/raffle', raffleRoutes);
app.use('/api/push', require('./routes/push'));
app.use('/api/events', require('./routes/events'));
app.use('/api/pdf', require('./routes/pdf'));

// Rutas HTML explícitas — sin caché para siempre recibir versión actualizada
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };
app.get('/', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/claim', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'claim', 'index.html')));
app.get('/entry', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'entry', 'index.html')));
app.get('/nfc', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'nfc', 'index.html')));

// Metadatos NFT para OpenSea / marketplaces ERC-1155
// El contrato llama a uri(tokenId) → devuelve esta URL con el JSON de cada nivel
const APP_URL = process.env.APP_URL || 'https://furancho-sessions-production.up.railway.app';
const NFT_METADATA = {
  1: {
    name: 'O Cautivo',
    description: 'El primer paso en el Furancho. Llevas una visita y ya sabes lo que es bueno. Bienvenido, neno.',
    image: `https://ipfs.io/ipfs/bafkreigd4y7hinbsllo57rgshlf2wszzutxh7nrwpzof6vemdvcmqorfim`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Nivel', value: '1' },
      { trait_type: 'Título', value: 'O Cautivo' },
      { trait_type: 'Visitas requeridas', value: '1' },
      { trait_type: 'Edición', value: 'Furancho Sessions 2026' }
    ]
  },
  2: {
    name: 'O Cunqueiro',
    description: 'Ya llevas dos visitas. Empiezas a conocer el sitio y el sitio empieza a conocerte a ti, ho.',
    image: `https://ipfs.io/ipfs/bafkreiacmqczigpyjhdv74ksuulpfxl7n3qqojs7jvr7in6bzqzt777xzq`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Nivel', value: '2' },
      { trait_type: 'Título', value: 'O Cunqueiro' },
      { trait_type: 'Visitas requeridas', value: '2' },
      { trait_type: 'Edición', value: 'Furancho Sessions 2026' }
    ]
  },
  3: {
    name: 'O Larpeiro',
    description: 'Cuatro visitas. Carallo, neno, esto ya no es casualidad. Eres un furancheiro de verdad.',
    image: `https://ipfs.io/ipfs/bafkreif3cfwvcobdeai7xxzs4kqii2ecj6fax7euq5q56uxa2dfxg2aqny`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Nivel', value: '3' },
      { trait_type: 'Título', value: 'O Larpeiro' },
      { trait_type: 'Visitas requeridas', value: '4' },
      { trait_type: 'Blockchain', value: 'Polygon' },
      { trait_type: 'Edición', value: 'Furancho Sessions 2026' }
    ]
  },
  4: {
    name: 'O Presidente do Furancho',
    description: 'Doce visitas. Malo será que no te conozca ya todo el barrio. Leyenda viva del Furancho, plas.',
    // El CID IPFS original del Nv4 no resuelve en ningún gateway (504) — se sirve desde la app
    image: `${APP_URL}/assets/nft_nivel4_presidente.jpg`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Nivel', value: '4' },
      { trait_type: 'Título', value: 'O Presidente do Furancho' },
      { trait_type: 'Visitas requeridas', value: '12' },
      { trait_type: 'Blockchain', value: 'Polygon' },
      { trait_type: 'Edición', value: 'Furancho Sessions 2026' }
    ]
  }
};

// Acepta tanto ID decimal (1,2,3,4) como hex zero-padded que usan algunos marketplaces
app.get('/nft-metadata/:id', (req, res) => {
  const raw = req.params.id;
  const tokenId = raw.length > 10 ? parseInt(raw, 16) : parseInt(raw, 10);
  const meta = NFT_METADATA[tokenId];
  if (!meta) return res.status(404).json({ error: 'Token no encontrado' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(meta);
});

// Archivos estáticos (assets y demás)
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/prize-images', express.static(path.join(__dirname, 'public', 'prize-images')));
app.use(express.static(path.join(__dirname, 'public')));

// Health check — Railway lo llama periódicamente para verificar que el servidor vive
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Auto-checkout al terminar el horario del evento (definido en la agenda) — comprueba cada minuto.
// La función sólo cierra sesiones cuando la hora de cierre del evento ya ha pasado.
// También re-evalúa las sesiones abiertas al activarse la ventana del evento: quien fichó
// demasiado pronto y sigue dentro recupera su visita (1 por semana).
function scheduleAutoCheckout() {
  setInterval(() => {
    try {
      const { autoCloseSessionsAfterEvent, countPendingVisitsDuringEvent } = require('./db/database');
      countPendingVisitsDuringEvent();
      autoCloseSessionsAfterEvent();
    } catch (_) {}
  }, 60 * 1000); // cada minuto
}
scheduleAutoCheckout();

// ─── SORTEO SEMANAL AUTOMÁTICO (Miércoles 21:00 hora Madrid) ──────────────────
// Lógica: cada miércoles a las 21:00 comprueba si hay evento el jueves siguiente.
//   - Si hay evento el jueves → lanza el sorteo semanal automáticamente.
//   - Si no hay evento → no hace nada (sin sorteo esa semana).
//   - Si el sorteo ya fue realizado (status='completed') → no lo repite.
// El ganador debe CONFIRMAR en la app antes de las 23:00 de esa misma noche;
// si no confirma, el premio se da por perdido automáticamente (ver sweeper más abajo).
function scheduleWeeklyRaffle() {
  setInterval(() => {
    // Hora actual en zona Madrid (UTC+1/UTC+2)
    const now = new Date();
    const madridHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));

    const isWednesday = madridHour.getDay() === 3;      // 0=Dom..6=Sab → 3=Mié
    const isDrawTime  = madridHour.getHours() === 21 && madridHour.getMinutes() === 0;

    if (!isWednesday || !isDrawTime) return;

    console.log('[WeeklyRaffle] Miércoles 21:00 — comprobando evento del jueves...');

    try {
      const { db, drawWeeklyRaffle, getWeeklyRaffleTargetWeek } = require('./db/database');

      // Calcular la fecha del jueves siguiente (mañana si hoy es miércoles)
      const thursday = new Date(madridHour);
      thursday.setDate(madridHour.getDate() + 1);
      const thursdayStr = thursday.toISOString().slice(0, 10); // YYYY-MM-DD

      // Verificar si hay evento grabado para ese jueves
      const event = db.prepare(
        `SELECT id, title FROM events WHERE event_date = ? LIMIT 1`
      ).get(thursdayStr);

      if (!event) {
        console.log(`[WeeklyRaffle] No hay evento el jueves ${thursdayStr}. Sin sorteo esta semana.`);
        return;
      }

      console.log(`[WeeklyRaffle] Evento encontrado el ${thursdayStr}: "${event.title}". Iniciando sorteo semanal...`);

      const weekStr = getWeeklyRaffleTargetWeek(madridHour);

      // Comprobar que no se haya sorteado ya esta semana
      const existing = db.prepare(`SELECT status FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
      if (existing && existing.status === 'completed') {
        console.log(`[WeeklyRaffle] Sorteo de ${weekStr} ya fue realizado. Nada que hacer.`);
        return;
      }

      // Verificar que hay participantes
      const count = db.prepare(`SELECT COUNT(*) as n FROM weekly_claims WHERE claimed_week = ?`).get(weekStr)?.n || 0;
      if (count === 0) {
        console.log(`[WeeklyRaffle] Semana ${weekStr}: 0 participantes apuntados. Sin sorteo.`);
        return;
      }

      // Realizar el sorteo
      const result = drawWeeklyRaffle(weekStr);
      console.log(`[WeeklyRaffle] ✅ Ganador automático semana ${weekStr}: ${result.winnerWallet} | Premio: ${result.prize} | Confirmar antes de: ${result.confirmDeadline}`);

      // Push a todos
      const { sendPushToAll } = require('./services/push');
      sendPushToAll(
        '🔑 ¡Chave Semanal sorteada!',
        `Ya hay ganador de ${result.prize}. Abre la app: si te tocó, confirma antes de las 23:00 de hoy o el premio se pierde, ho.`,
        { url: '/claim' }
      );

      // SSE: notificar al ganador (si está conectado) y a todos los demás.
      // El código NO se envía: se revela al confirmar en la app.
      const { broadcast } = require('./routes/raffle');
      broadcast('weekly_draw_result', {
        winnerWallet: result.winnerWallet,
        prize: result.prize,
        confirmDeadline: result.confirmDeadline,
        week: weekStr
      }, result.winnerWallet);

      broadcast('weekly_draw_closed', {
        prize: result.prize,
        week: weekStr
      });

    } catch (e) {
      // Si no hay participantes u otro error, loguear sin crashear
      console.error('[WeeklyRaffle] Error en sorteo automático:', e.message);
    }

  }, 60 * 1000); // comprueba cada minuto
}
scheduleWeeklyRaffle();

// ─── AUTO-PÉRDIDA DE LA CHAVE (sin confirmar antes de las 23:00) ──────────────
// Cada minuto: si el ganador no confirmó dentro del plazo, el premio queda como
// 'forfeited' — visible en los listados del admin y en el historial del cliente.
function scheduleWeeklyForfeitSweep() {
  setInterval(() => {
    try {
      const { forfeitExpiredWeeklyRaffles } = require('./db/database');
      const expired = forfeitExpiredWeeklyRaffles();
      if (!expired.length) return;
      const { broadcast } = require('./routes/raffle');
      expired.forEach(r => {
        console.log(`[WeeklyRaffle] ⌛ Premio de ${r.claimed_week} (${r.prize}) dado por perdido — el ganador no confirmó a tiempo`);
        if (r.winner_wallet) {
          broadcast('weekly_forfeited', { prize: r.prize, week: r.claimed_week }, r.winner_wallet);
        }
        // Refrescar la tarjeta semanal de todos los clientes conectados
        broadcast('weekly_draw_closed', { prize: r.prize, week: r.claimed_week });
      });
    } catch (e) {
      console.error('[WeeklyRaffle] Error en auto-pérdida:', e.message);
    }
  }, 60 * 1000);
}
scheduleWeeklyForfeitSweep();

// ─── PUSH "¿CUÁNDO VUELVES?" — 6 días sin visita + evento mañana ─────────────
// Se ejecuta cada minuto pero solo dispara una vez al día a las 18:00 hora Madrid.
let _lastComebackCheckDate = null;

function scheduleComebackPushes() {
  setInterval(async () => {
    try {
      const now = new Date();
      const madridStr = now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
      const madridDate = new Date(madridStr);
      const hour = madridDate.getHours();
      const yyyy = madridDate.getFullYear();
      const mm = String(madridDate.getMonth() + 1).padStart(2, '0');
      const dd = String(madridDate.getDate()).padStart(2, '0');
      const todayStr = `${yyyy}-${mm}-${dd}`;

      // Solo disparar una vez al día a las 18:00 h Madrid
      if (hour !== 18 || _lastComebackCheckDate === todayStr) return;
      _lastComebackCheckDate = todayStr;

      const { db } = require('./db/database');

      // Calcular fecha de mañana en Madrid
      const tmrw = new Date(madridDate);
      tmrw.setDate(tmrw.getDate() + 1);
      const ty = tmrw.getFullYear();
      const tm = String(tmrw.getMonth() + 1).padStart(2, '0');
      const td = String(tmrw.getDate()).padStart(2, '0');
      const tomorrowStr = `${ty}-${tm}-${td}`;

      // Solo si hay evento activo mañana
      const event = db.prepare(`SELECT title FROM events WHERE event_date = ? AND active = 1`).get(tomorrowStr);
      if (!event) return;

      // Wallets con push subscription, que han visitado alguna vez,
      // pero NO en los últimos 6 días
      const wallets = db.prepare(`
        SELECT DISTINCT ps.wallet_address
        FROM push_subscriptions ps
        WHERE ps.wallet_address IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM sessions s2
            WHERE s2.wallet_address = ps.wallet_address
              AND s2.counted_as_visit = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.wallet_address = ps.wallet_address
              AND s.counted_as_visit = 1
              AND s.entry_time >= datetime('now', '-6 days')
          )
      `).all();

      if (!wallets.length) return;

      const { sendPushToWallet } = require('./services/push');
      for (const w of wallets) {
        sendPushToWallet(
          w.wallet_address,
          'Furancho Sessions 🍷',
          `Mañana hay Furancho, ¿vienes?`,
          { url: '/claim' }
        );
      }
      console.log(`[Comeback] 🍷 Push enviado a ${wallets.length} furancheiros ausentes (evento mañana: ${event.title})`);
    } catch (e) {
      console.error('[Comeback] Error:', e.message);
    }
  }, 60 * 1000);
}
scheduleComebackPushes();

// ─── AUTO-LANZAMIENTO DE SORTEOS PROGRAMADOS ─────────────────────────────────
// Cada minuto comprueba si hay sorteos con hora = hora actual en Madrid que aún están pendientes.
// Si los encuentra, los lanza automáticamente igual que si el admin pulsara "Lanzar".
// IDs de sorteos a los que ya se les mandó el aviso de 15min (reset en cada arranque del server)
const _notifiedRaffleIds = new Set();

function scheduleAutoRaffles() {
  setInterval(() => {
    const now = new Date();
    const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const currentTime = `${String(madridTime.getHours()).padStart(2,'0')}:${String(madridTime.getMinutes()).padStart(2,'0')}`;
    const currentDate = `${madridTime.getFullYear()}-${String(madridTime.getMonth()+1).padStart(2,'0')}-${String(madridTime.getDate()).padStart(2,'0')}`;

    // Hora que será en 15 minutos
    const in15 = new Date(madridTime.getTime() + 15 * 60 * 1000);
    const in15Time = `${String(in15.getHours()).padStart(2,'0')}:${String(in15.getMinutes()).padStart(2,'0')}`;

    try {
      const { db } = require('./db/database');
      const { sendPushToAll } = require('./services/push');

      // ── Avisos 15 min antes ──────────────────────────────────────────────
      const upcoming = db.prepare(
        `SELECT * FROM scheduled_raffles WHERE status = 'pending' AND event_date = ? AND scheduled_time = ?`
      ).all(currentDate, in15Time);

      upcoming.forEach(s => {
        if (!_notifiedRaffleIds.has(s.id)) {
          _notifiedRaffleIds.add(s.id);
          const prizeName = s.hide_name ? 'Sorpresa 🎁' : s.prize;
          sendPushToAll(
            '⏰ ¡Sorteo en 15 minutos!',
            `${prizeName} — abre la app para estar listo, neno 🍷`,
            { url: '/claim' }
          );
          console.log(`[AutoRaffle] 🔔 Aviso 15min enviado para sorteo #${s.id}: "${s.prize}"`);
        }
      });

      // ── Lanzamiento automático ───────────────────────────────────────────
      const pending = db.prepare(
        `SELECT * FROM scheduled_raffles WHERE status = 'pending' AND event_date = ? AND scheduled_time = ?`
      ).all(currentDate, currentTime);

      if (!pending.length) return;

      const { doLaunch } = require('./routes/raffle');
      pending.forEach(s => {
        console.log(`[AutoRaffle] ⏰ Lanzando automáticamente #${s.id}: "${s.prize}" (${s.type || 'night'}) a las ${s.scheduled_time}`);
        try {
          const result = doLaunch({
            prize: s.prize,
            type: s.type || 'night',
            targetLevel: s.target_level,
            participantLevel: s.participant_level,
            prizeDetails: s.prize_details,
            prizeImage: s.prize_image,
            establishment: s.establishment,
            hideName: s.hide_name ? true : false,
            scheduledId: s.id
          });
          console.log(`[AutoRaffle] ✅ Sorteo #${s.id} lanzado — ganador: ${result.winnerWallet.slice(0,6)}..., código: ${result.verificationCode}`);
        } catch(e) {
          console.error(`[AutoRaffle] ❌ Error lanzando sorteo #${s.id}:`, e.message);
        }
      });
    } catch(e) {
      console.error('[AutoRaffle] Error en scheduler:', e.message);
    }
  }, 60 * 1000);
}
scheduleAutoRaffles();

// Iniciar servidor
const server = app.listen(PORT, () => {
  const { DEMO_MODE } = require('./services/crossmint');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'furancho.db');
  console.log(`
╔══════════════════════════════════════════╗
║   🍷 FURANCHO SESSIONS NFT — SERVIDOR    ║
╠══════════════════════════════════════════╣
║  URL: http://localhost:${PORT}              ║
║  Admin: http://localhost:${PORT}/admin      ║
║  Claim: http://localhost:${PORT}/claim?level=1  ║
║  Modo: ${DEMO_MODE ? '🟡 DEMO (sin Crossmint real)' : '🟢 PRODUCCIÓN'}     ║
║  DB: ${DB_PATH.length > 30 ? '...'+DB_PATH.slice(-27) : DB_PATH.padEnd(30)} ║
╚══════════════════════════════════════════╝
  `);
});

// ─── Cierre limpio (SIGTERM = Railway para el contenedor; SIGINT = Ctrl+C local) ───
// Sin esto, npm reporta "signal SIGTERM → command failed" aunque sea un cierre normal.
function gracefulShutdown(signal) {
  console.log(`[Server] Señal ${signal} recibida — cerrando limpiamente...`);
  
  // Cerrar todas las conexiones activas inmediatamente (incluido Server-Sent Events)
  // para que server.close() no se quede colgado esperando
  if (typeof server.closeAllConnections === 'function') {
    console.log('[Server] Cerrando todas las conexiones activas (incluyendo SSE)...');
    server.closeAllConnections();
  }

  server.close(() => {
    console.log('[Server] Conexiones HTTP cerradas.');
    // Cerrar SQLite correctamente para que el WAL se flush antes de salir
    try {
      const { db } = require('./db/database');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[Server] DB SQLite cerrada correctamente.');
    } catch (e) {
      console.error('[Server] Error cerrando DB:', e.message);
    }
    process.exit(0);
  });

  // Forzar salida si tarda más de 10 segundos (Railway espera máximo ~30s)
  setTimeout(() => {
    console.error('[Server] Forzando salida tras timeout de cierre.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = app;

