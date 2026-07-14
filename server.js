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
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/campaign', require('./routes/campaign'));

// Rutas HTML explícitas — sin caché para siempre recibir versión actualizada
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };
app.get('/', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/admin', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/claim', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'claim', 'index.html')));
app.get('/entry', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'entry', 'index.html')));
app.get('/staff', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'staff', 'index.html')));
app.get('/nfc', (req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'public', 'nfc', 'index.html')));

// Metadatos NFT para OpenSea / marketplaces ERC-1155
// El contrato llama a uri(tokenId) → devuelve esta URL con el JSON de cada nivel
const APP_URL = process.env.APP_URL || 'https://furancho-sessions-production.up.railway.app';
const NFT_METADATA = {
  1: {
    name: 'O Cautivo',
    description: 'El primer paso en el Furancho. Llevas una visita y ya sabes lo que es bueno. Bienvenido, neno.',
    image: `${APP_URL}/assets/nft_nivel1_cautivo.jpg`,
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
    image: `${APP_URL}/assets/nft_nivel2_cunqueiro.jpg`,
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
    image: `${APP_URL}/assets/nft_nivel3_larpeiro.jpg`,
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
    image: `${APP_URL}/assets/nft_nivel4_presidente.jpg`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Nivel', value: '4' },
      { trait_type: 'Título', value: 'O Presidente do Furancho' },
      { trait_type: 'Visitas requeridas', value: '12' },
      { trait_type: 'Blockchain', value: 'Polygon' },
      { trait_type: 'Edición', value: 'Furancho Sessions 2026' }
    ]
  },
  104: {
    name: 'Furancheiro de Honor',
    description: 'Miembro de Honor do Furancho. NFT exclusivo por reservar mesa VIP en la app 2 veces y asistir a las sesiones.',
    image: `${APP_URL}/assets/furancheiro_honor.jpg`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Tipo', value: 'Especial' },
      { trait_type: 'Edición', value: 'Miembro de Honor (Max 25)' },
      { trait_type: 'Blockchain', value: 'Polygon' }
    ]
  },
  105: {
    name: 'Guardián del Furancho',
    description: 'Guardián Oficial do Furancho. NFT exclusivo para los protectores de la cunca y el barril.',
    image: `${APP_URL}/assets/nft_guardian_furancho.jpg`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Tipo', value: 'Especial' },
      { trait_type: 'Edición', value: 'Limitada (Max 25)' },
      { trait_type: 'Blockchain', value: 'Polygon' }
    ]
  },
  50: {
    name: 'Meme VIP',
    description: 'Edición Limitada. Meme oficial VIP para experiencias exclusivas de hotel y mucho más.',
    image: `${APP_URL}/assets/nft_meme_vip.jpg`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Tipo', value: 'Meme VIP' },
      { trait_type: 'Edición', value: 'Limitada (Max 50)' },
      { trait_type: 'Blockchain', value: 'Polygon' }
    ]
  }
};

// Acepta tanto ID decimal (1,2,3,4) como hex (con/sin 0x, con/sin .json) que usan los marketplaces
app.get('/nft-metadata/:id', (req, res) => {
  let raw = req.params.id.trim();
  if (raw.toLowerCase().endsWith('.json')) {
    raw = raw.slice(0, -5);
  }
  let tokenId;
  if (raw.toLowerCase().startsWith('0x')) {
    tokenId = parseInt(raw, 16);
  } else if (raw.length > 10) {
    tokenId = parseInt(raw, 16);
  } else {
    tokenId = parseInt(raw, 10);
  }

  // Niveles (1-4) en NFT_METADATA; logros (token >= 100) desde el catálogo de logros.
  const meta = NFT_METADATA[tokenId] || require('./services/achievements').metadataForToken(tokenId);
  if (!meta) return res.status(404).json({ error: 'Token no encontrado' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(meta);
});


// Archivos estáticos (assets y demás)
app.use('/assets', express.static(path.join(__dirname, 'assets')));
// Imágenes de premio: primero el directorio PERSISTENTE (uploads del admin, volumen
// Railway), y como fallback las versionadas en el repo (express.static hace passthrough
// si no encuentra el archivo en el primero).
const { UPLOADS_DIR } = require('./db/database');
app.use('/prize-images', express.static(UPLOADS_DIR));
app.use('/prize-images', express.static(path.join(__dirname, 'public', 'prize-images')));

// Manifest dinámico para soportar aislamiento de sandbox PWA en iOS
app.get('/manifest.json', (req, res) => {
  const fs = require('fs');
  const manifestPath = path.join(__dirname, 'public', 'manifest.json');
  fs.readFile(manifestPath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Error al cargar manifest' });
    }
    try {
      const manifest = JSON.parse(data);
      if (req.query.restore && /^0x[a-fA-F0-9]{40}$/.test(req.query.restore)) {
        manifest.start_url = `/claim?restore=${encodeURIComponent(req.query.restore)}`;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json(manifest);
    } catch (parseErr) {
      res.status(500).json({ error: 'Error al procesar manifest' });
    }
  });
});

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
// Lógica: cada minuto, miércoles entre las 21:00 y las 21:04 (ventana robusta):
//   - Si hay un premio configurado para la semana objetivo → lanza el sorteo.
//   - Si no hay premio pero hay evento el jueves siguiente → también lanza.
//   - Si el sorteo ya fue realizado esta semana → no lo repite (flag lastDrawnWeek).
// La ventana de 5 min permite que un reinicio del servidor no se pierda el disparo.
// El ganador debe CONFIRMAR en la app antes de las 23:59 de esa misma noche;
// si no confirma, el premio se da por perdido automáticamente (ver sweeper más abajo).
let _weeklyLastDrawnWeek = null; // anti double-fire: semana ya sorteada esta sesión
function scheduleWeeklyRaffle() {
  setInterval(() => {
    const now = new Date();
    const madridHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));

    const isWednesday = madridHour.getDay() === 3;
    const h = madridHour.getHours();
    const m = madridHour.getMinutes();
    const isDrawWindow = h === 21 && m >= 0 && m <= 4; // ventana 21:00-21:04

    if (!isWednesday || !isDrawWindow) return;

    try {
      const { db, drawWeeklyRaffle, getWeeklyRaffleTargetWeek, hasEventOnThursday } = require('./db/database');

      const weekStr = getWeeklyRaffleTargetWeek(madridHour);

      // Anti double-fire: si ya sorteamos esta semana en esta sesión, skip
      if (_weeklyLastDrawnWeek === weekStr) return;

      // Comprobar si ya está en DB como completed/forfeited
      const existing = db.prepare(`SELECT status, prize, winners_count FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
      if (existing && (existing.status === 'completed' || existing.status === 'forfeited')) {
        _weeklyLastDrawnWeek = weekStr;
        console.log(`[WeeklyRaffle] Sorteo de ${weekStr} ya fue realizado o caducado. Nada que hacer.`);
        return;
      }

      const hasPrize = existing && existing.prize;
      const eventOnThursday = hasEventOnThursday();

      if (!hasPrize && !eventOnThursday) {
        console.log(`[WeeklyRaffle] Miércoles 21:00 — sin premio configurado ni evento el jueves. Sin sorteo.`);
        _weeklyLastDrawnWeek = weekStr;
        return;
      }

      if (hasPrize) {
        console.log(`[WeeklyRaffle] ⏰ 21:00 — lanzando sorteo "${existing.prize}" (${existing.winners_count || 1} premios) para semana ${weekStr}...`);
      } else {
        console.log(`[WeeklyRaffle] ⏰ 21:00 — evento el jueves. Lanzando sorteo semanal para semana ${weekStr}...`);
      }

      // Verificar que hay participantes
      const count = db.prepare(`SELECT COUNT(*) as n FROM weekly_claims WHERE claimed_week = ?`).get(weekStr)?.n || 0;
      if (count === 0) {
        console.log(`[WeeklyRaffle] Semana ${weekStr}: 0 participantes apuntados. Sin sorteo.`);
        _weeklyLastDrawnWeek = weekStr;
        return;
      }

      // Realizar el sorteo
      const result = drawWeeklyRaffle(weekStr);
      _weeklyLastDrawnWeek = weekStr;
      let winners;
      try { winners = JSON.parse(result.winnerWallet); } catch(e) { winners = [result.winnerWallet]; }
      const winCount = winners.length;
      console.log(`[WeeklyRaffle] ✅ ${winCount} ganador(es) automático(s) semana ${weekStr}: ${result.winnerWallet} | Premio: ${result.prize} | Confirmar antes de: ${result.confirmDeadline}`);

      const { sendPushToAll, sendPushToWallets } = require('./services/push');
      sendPushToAll(
        '🔑 ¡Chave Semanal sorteada!',
        `${winCount > 1 ? `Hay ${winCount} ganadores` : 'Ya hay ganador'} de ${result.prize}. Abre la app: si te tocó, confirma antes de las 23:59 de hoy o el premio se pierde, ho.`,
        { url: '/claim' }
      );

      // Push directo al ganador (puede no tener la app abierta)
      sendPushToWallets(
        winners,
        '🏆 ¡GANACHES A CHAVE, HO!',
        `Tocouche "${result.prize}". Abre a app e confirma antes das 23:59 ou o premio pérdese. ¡Corre, rapaz!`,
        { url: '/claim' }
      );

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
      console.error('[WeeklyRaffle] Error en sorteo automático:', e.message);
    }

  }, 60 * 1000); // comprueba cada minuto
}
scheduleWeeklyRaffle();


// ─── PUSHES DEL CICLO DE LA CHAVE (apertura domingo + recordatorio martes) ───
// Domingo 21:00: la ventana se abre → push a todos.
// Martes 20:00: último día para apuntarse → recordatorio a todos.
let _lastWeeklyOpenPush = null;
let _lastWeeklyReminderPush = null;
function scheduleWeeklyLifecyclePushes() {
  setInterval(async () => {
    try {
      const now = new Date();
      const madrid = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const day = madrid.getDay();
      const h = madrid.getHours();
      const yyyy = madrid.getFullYear();
      const mm = String(madrid.getMonth() + 1).padStart(2, '0');
      const dd = String(madrid.getDate()).padStart(2, '0');
      const todayStr = `${yyyy}-${mm}-${dd}`;

      const { db, getWeeklyRaffleTargetWeek } = require('./db/database');

      // ── Domingo 21:00 — ventana abierta ──────────────────────────────────
      if (day === 0 && h === 21 && _lastWeeklyOpenPush !== todayStr) {
        _lastWeeklyOpenPush = todayStr;
        const weekStr = getWeeklyRaffleTargetWeek(madrid);
        const raffle = db.prepare(`SELECT prize FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
        if (raffle && raffle.prize) {
          const { sendPushToAll } = require('./services/push');
          sendPushToAll(
            '🔑 ¡A Chave Semanal xa está aberta!',
            `Esta semana se sortea: ${raffle.prize}. Abre a app e apúntate antes do mércores ás 21:00. ¡Non te quedes fóra, ho! 🍷`,
            { url: '/claim' }
          );
          console.log(`[WeeklyPush] 🔑 Push apertura Chave semana ${weekStr}`);
        }
      }

      // ── Martes 20:00 — recordatorio último día ────────────────────────────
      if (day === 2 && h === 20 && _lastWeeklyReminderPush !== todayStr) {
        _lastWeeklyReminderPush = todayStr;
        const weekStr = getWeeklyRaffleTargetWeek(madrid);
        const raffle = db.prepare(`SELECT prize FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
        if (raffle && raffle.prize) {
          const { sendPushToAll } = require('./services/push');
          sendPushToAll(
            '⏰ Mañá se sortea a Chave!',
            `O sorteo xa está en marcha. Premio: ${raffle.prize}. Se non te apuntaches, hoxe é o último día, ho.`,
            { url: '/claim' }
          );
          console.log(`[WeeklyPush] ⏰ Recordatorio Chave martes`);
        }
      }
    } catch (e) {
      console.error('[WeeklyPush] Error:', e.message);
    }
  }, 60 * 1000);
}
scheduleWeeklyLifecyclePushes();

// ─── AUTO-PÉRDIDA DE LA CHAVE (sin confirmar antes de las 23:59) ──────────────
// Cada minuto: si el ganador no confirmó dentro del plazo, el premio queda como
// 'forfeited' — visible en los listados del admin y en el historial del cliente.
function scheduleWeeklyForfeitSweep() {
  setInterval(() => {
    try {
      const { forfeitExpiredWeeklyRaffles } = require('./db/database');
      const expired = forfeitExpiredWeeklyRaffles();
      if (!expired.length) return;
      const { broadcast } = require('./routes/raffle');
      const { sendPushToWallet } = require('./services/push');
      expired.forEach(r => {
        // r.wallets = solo los ganadores que NO confirmaron a tiempo (por-ganador)
        console.log(`[WeeklyRaffle] ⌛ ${r.wallets.length} ganador(es) de ${r.claimed_week} (${r.prize}) no confirmaron a tiempo`);
        (r.wallets || []).forEach(w => {
          if (!w) return;
          broadcast('weekly_forfeited', { prize: r.prize, week: r.claimed_week }, w);
          sendPushToWallet(
            w,
            'Furancho Sessions 🍷',
            'El tiempo para confirmar tu premio ha terminado... mala suerte para la próxima. 🍷',
            { url: '/claim' }
          );
        });
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

// ─── PUSH "LO QUE TE PERDISTE" — resumen del evento a los que NO vinieron ───
// Se dispara a las 13:00 del día SIGUIENTE al evento. Solo envía a wallets con
// push subscription que NO ficharon entrada esa noche. Datos reales, sin inventar.
let _lastRecapDate = null;
function scheduleEventRecapPush() {
  setInterval(async () => {
    try {
      const now = new Date();
      const madridStr = now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
      const madrid = new Date(madridStr);
      const hour = madrid.getHours();
      const todayStr = `${madrid.getFullYear()}-${String(madrid.getMonth() + 1).padStart(2, '0')}-${String(madrid.getDate()).padStart(2, '0')}`;

      if (hour !== 13 || _lastRecapDate === todayStr) return;
      _lastRecapDate = todayStr;

      const { db, getEventRecap } = require('./db/database');

      const yesterday = new Date(madrid);
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      const event = db.prepare(`SELECT title FROM events WHERE event_date = ? AND active = 1`).get(yStr);
      if (!event) return;

      const recap = getEventRecap(yStr);
      if (recap.attendees < 1) return;

      const parts = [];
      if (recap.prizes.length > 0) {
        const names = recap.prizes.map(p => p.prize).slice(0, 3);
        parts.push(`se sortearon ${recap.prizes.length} premio${recap.prizes.length > 1 ? 's' : ''} (${names.join(', ')})`);
      }
      if (recap.levelUps > 0) parts.push(`${recap.levelUps} persona${recap.levelUps > 1 ? 's subieron' : ' subió'} de nivel`);
      if (recap.nftsMinted > 0) parts.push(`${recap.nftsMinted} NFT${recap.nftsMinted > 1 ? 's' : ''} repartido${recap.nftsMinted > 1 ? 's' : ''}`);

      if (parts.length === 0) return;

      const attendeeSet = new Set(recap.attendeeWallets);
      const allSubs = db.prepare(`
        SELECT DISTINCT wallet_address FROM push_subscriptions
        WHERE wallet_address IS NOT NULL
      `).all();
      const absentWallets = allSubs
        .map(s => s.wallet_address.toLowerCase())
        .filter(w => !attendeeSet.has(w));

      if (!absentWallets.length) return;

      const body = `Onte no Furancho: ${parts.join(', ')}. Ti non estabas, ho. A próxima non te a perdas. 🍷`;

      const { sendPushToWallet } = require('./services/push');
      let sent = 0;
      for (const w of absentWallets) {
        try {
          await sendPushToWallet(w, 'O que te perdiches 🍷', body, { url: '/claim' });
          sent++;
        } catch (_) {}
      }
      console.log(`[Recap] 📨 Push "lo que te perdiste" enviado a ${sent}/${absentWallets.length} ausentes (evento ${yStr})`);
    } catch (e) {
      console.error('[Recap] Error:', e.message);
    }
  }, 60 * 1000);
}
scheduleEventRecapPush();

// ─── ENVÍO AUTOMÁTICO DE MENSAJES PROGRAMADOS ───────────────────────────────
// Cada minuto comprueba si hay mensajes programados pendientes cuya fecha/hora sea menor o igual a la actual en Madrid.
// Si los encuentra, los envía y los marca como 'sent'.
function scheduleAutoMessages() {
  setInterval(() => {
    const now = new Date();
    const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const yyyy = madridTime.getFullYear();
    const mm = String(madridTime.getMonth() + 1).padStart(2, '0');
    const dd = String(madridTime.getDate()).padStart(2, '0');
    const hh = String(madridTime.getHours()).padStart(2, '0');
    const min = String(madridTime.getMinutes()).padStart(2, '0');
    const currentMadridStr = `${yyyy}-${mm}-${dd} ${hh}:${min}`;

    try {
      const { db, getScheduledMessages } = require('./db/database');
      const { getWalletsByLevel, getWalletsByAchievement, getEligibleRaffleParticipants } = require('./db/database');
      const { sendPushToAll, sendPushToWallets, sendPushToWallet } = require('./services/push');

      const pending = db.prepare(`
        SELECT * FROM scheduled_messages 
        WHERE status = 'pending' AND send_at <= ?
      `).all(currentMadridStr);

      if (!pending.length) return;

      pending.forEach(msg => {
        console.log(`[AutoMessage] ⏰ Publicando automáticamente mensaje #${msg.id}: "${msg.subject}" programado para ${msg.send_at}`);

        const levelFilter = msg.level_filter || 'all';
        const checkedInOnly = levelFilter === 'checkedin';
        const isAchFilter = typeof levelFilter === 'string' && levelFilter.startsWith('ach:');
        const wallets = checkedInOnly
          ? getEligibleRaffleParticipants()
          : isAchFilter
            ? getWalletsByAchievement(levelFilter.slice(4))
            : getWalletsByLevel(levelFilter);

        // Guardar en tabla histórica
        db.prepare(`
          INSERT INTO messages (subject, body, level_filter, recipient_count, rsvp_event_id, action_type, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(msg.subject, msg.body, levelFilter, wallets.length, msg.rsvp_event_id, msg.action_type);

        // Marcar enviado
        db.prepare(`
          UPDATE scheduled_messages 
          SET status = 'sent' 
          WHERE id = ?
        `).run(msg.id);

        // PUSH a los móviles
        if (checkedInOnly || isAchFilter) {
          sendPushToWallets(wallets, `📢 ${msg.subject}`, msg.body, { url: '/claim' });
        } else if (levelFilter && levelFilter.startsWith('0x')) {
          sendPushToWallet(levelFilter, `✉️ Mensaje privado: ${msg.subject}`, msg.body, { url: '/claim' });
        } else {
          sendPushToAll(`📢 ${msg.subject}`, msg.body, { url: '/claim' });
        }

        console.log(`[AutoMessage] ✅ Mensaje #${msg.id} enviado a ${wallets.length} destinatarios.`);
      });
    } catch (err) {
      console.error('[AutoMessage] Error running scheduled messages:', err.message);
    }
  }, 60 * 1000);
}
scheduleAutoMessages();

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
      const { db, getEligibleRaffleParticipants } = require('./db/database');
      const { sendPushToWallets } = require('./services/push');

      // ── Avisos 15 min antes ──────────────────────────────────────────────
      const upcoming = db.prepare(
        `SELECT * FROM scheduled_raffles WHERE status = 'pending' AND event_date = ? AND scheduled_time = ?`
      ).all(currentDate, in15Time);

      upcoming.forEach(s => {
        if (!_notifiedRaffleIds.has(s.id)) {
          _notifiedRaffleIds.add(s.id);
          // Solo a quien está en el local con entrada fichada — nunca a gente en casa.
          const eligible = getEligibleRaffleParticipants();
          if (!eligible.length) {
            console.log(`[AutoRaffle] 🔕 Aviso 15min de #${s.id} omitido: nadie fichado en el local`);
            return;
          }
          // Texto NEUTRO: no repetimos el texto del premio (hacía pensar que les había tocado).
          sendPushToWallets(
            eligible,
            '⏰ ¡Sorteo en 15 minutos!',
            'Prepárate, que en nada sorteamos premio en el local. Ten la app a mano para entrar al bombo, neno 🍷',
            { url: '/claim' }
          );
          console.log(`[AutoRaffle] 🔔 Aviso 15min enviado a ${eligible.length} fichado(s) para sorteo #${s.id}`);
        }
      });

      // ── Lanzamiento automático ───────────────────────────────────────────
      // DESACTIVADO: El usuario solicitó lanzar los sorteos programados manualmente para evitar problemas con la música.
      // Quedan en estado 'pending' y se lanzan desde el panel de administración (/admin).
      /*
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
      */
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

