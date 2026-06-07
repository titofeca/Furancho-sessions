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

// Archivos estáticos (assets y demás)
app.use('/assets', express.static(path.join(__dirname, 'assets')));
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

// Auto-checkout a las 23:00 — comprueba cada minuto si es hora de cerrar sesiones
function scheduleAutoCheckout() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() === 0) {
      const { autoCloseSessionsAt23 } = require('./db/database');
      autoCloseSessionsAt23();
    }
  }, 60 * 1000); // cada minuto
}
scheduleAutoCheckout();

// ─── SORTEO SEMANAL AUTOMÁTICO (Miércoles 20:00 hora Madrid) ──────────────────
// Lógica: cada miércoles a las 20:00 comprueba si hay evento el jueves siguiente.
//   - Si hay evento el jueves → lanza el sorteo semanal automáticamente.
//   - Si no hay evento → no hace nada (sin sorteo esa semana).
//   - Si el sorteo ya fue realizado (status='completed') → no lo repite.
function scheduleWeeklyRaffle() {
  setInterval(() => {
    // Hora actual en zona Madrid (UTC+1/UTC+2)
    const now = new Date();
    const madridHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));

    const isWednesday = madridHour.getDay() === 3;      // 0=Dom..6=Sab → 3=Mié
    const isDrawTime  = madridHour.getHours() === 20 && madridHour.getMinutes() === 0;

    if (!isWednesday || !isDrawTime) return;

    console.log('[WeeklyRaffle] Miércoles 20:00 — comprobando evento del jueves...');

    try {
      const { db, drawWeeklyRaffle } = require('./db/database');

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

      // Calcular semana ISO actual
      function getYearWeek(d = new Date()) {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
        return `${date.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
      }
      const weekStr = getYearWeek(madridHour);

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
      console.log(`[WeeklyRaffle] ✅ Ganador automático semana ${weekStr}: ${result.winnerWallet} | Premio: ${result.prize} | Código: ${result.verificationCode}`);

      // Push a todos
      const { sendPushToAll } = require('./services/push');
      sendPushToAll(
        '🔑 ¡Chave Semanal Sorteada!',
        `El ganador de ${result.prize} ya tiene su código. ¡Pásate esta semana por el Furancho!`,
        { url: '/claim' }
      );

      // SSE: notificar al ganador (si está conectado) y a todos los demás
      const { broadcast } = require('./routes/raffle');
      broadcast('weekly_draw_result', {
        winnerWallet: result.winnerWallet,
        prize: result.prize,
        verificationCode: result.verificationCode,
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

