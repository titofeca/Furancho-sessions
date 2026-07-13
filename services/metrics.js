// ─────────────────────────────────────────────────────────────────────────────
//  MOTOR CANÓNICO DE MÉTRICAS — única fuente de verdad para toda la analítica.
//
//  Antes había ~9 endpoints, cada uno con su propia definición de "asistente",
//  "visita", "nuevo", "estancia" y "pico". Daban números distintos para el mismo
//  concepto. Este módulo centraliza TODO: cualquier endpoint o gráfico debe leer
//  de aquí para que los números coincidan en todos los puntos del panel.
//
//  DEFINICIONES CANÓNICAS
//  ----------------------
//  · Evento real      → fila en `events` con active=1 y que NO sea de prueba.
//  · Ventana de evento→ [start_time, end_time] en hora Madrid, con 1h de margen
//                        antes de la apertura (los que llegan pronto cuentan).
//                        Si end<=start la ventana cruza medianoche (+24h).
//  · Asistencia       → 1 por (wallet, evento): el wallet fichó dentro de la
//                        ventana de ese evento. Aunque fiche varias veces esa
//                        noche, cuenta como UNA asistencia.
//  · Asistentes       → nº de wallets distintas con asistencia ese día.
//  · Nuevo            → wallet cuya PRIMERA asistencia (de toda su historia) es
//                        ese evento. El resto son recurrentes.
//  · Estancia         → (última salida − primera entrada) de esa noche, en min,
//                        calculada de los timestamps reales (no del valor de
//                        relleno guardado). Si sigue dentro, se usa el cierre
//                        del evento. Se descartan valores absurdos (>12h).
//  · Aforo / pico     → concurrencia real: gente dentro en cada instante,
//                        derivada de entry/exit. El pico es el máximo.
//
//  Toda conversión horaria usa la zona Europe/Madrid de forma robusta a DST
//  (sin el antiguo "+2 horas" cableado que se rompía en invierno).
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require('../db/database');

// Margen antes de la apertura en el que la entrada ya cuenta (igual que el resto del sistema).
const EVENT_EARLY_MARGIN_MS = 60 * 60 * 1000;
// Estancia máxima creíble: por encima se considera dato corrupto y se descarta.
const MAX_STAY_MIN = 12 * 60;

// ── Helpers de zona horaria (Madrid) ─────────────────────────────────────────

// Convierte una cadena UTC de SQLite ('YYYY-MM-DD HH:MM:SS') a epoch ms.
function utcStrToMs(s) {
  if (!s) return null;
  const ms = new Date(s.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Offset de Madrid (ms) respecto a UTC para un instante dado — gestiona verano/invierno.
function madridOffsetMs(atMs) {
  const d = new Date(atMs);
  const asMadrid = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const asUTC = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return asMadrid.getTime() - asUTC.getTime();
}

// Convierte una hora de pared en Madrid (y-m-d h:mi) al instante UTC real (epoch ms).
function madridWallToMs(y, mo, d, h, mi) {
  const asIfUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  // El offset depende del instante; con una iteración basta salvo en el salto DST (madrugada).
  const off = madridOffsetMs(asIfUTC);
  return asIfUTC - off;
}

// Componentes de fecha/hora en Madrid para un epoch ms.
function madridParts(ms) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(ms));
  const m = {};
  p.forEach(x => { m[x.type] = x.value; });
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    hour: parseInt(m.hour, 10) % 24,
    minute: parseInt(m.minute, 10)
  };
}

// ── Carga de eventos reales y sus ventanas ───────────────────────────────────

function getRealEvents() {
  const rows = db.prepare(`
    SELECT id, event_date, title, start_time, end_time, vip_max
    FROM events
    WHERE active = 1
      AND title NOT LIKE '%Test%' AND title NOT LIKE '%test%'
    ORDER BY event_date ASC
  `).all();

  return rows.map(e => {
    const [y, mo, d] = e.event_date.split('-').map(Number);
    const [sh, sm] = (e.start_time || '19:00').split(':').map(Number);
    const [eh, em] = (e.end_time || '23:59').split(':').map(Number);
    const startMs = madridWallToMs(y, mo, d, sh, sm);
    let endMs = madridWallToMs(y, mo, d, eh, em);
    if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000; // cruza medianoche
    return {
      id: e.id,
      event_date: e.event_date,
      title: e.title,
      start_time: e.start_time || '19:00',
      end_time: e.end_time || '23:59',
      startMs,
      endMs,
      eligibleStartMs: startMs - EVENT_EARLY_MARGIN_MS,
      startHour: sh,
      endHour: eh
    };
  });
}

// ── Núcleo: asigna cada sesión a su evento y agrega por evento ───────────────

function analyze() {
  const events = getRealEvents();
  if (!events.length) return { events: [], byDate: new Map(), walletFirstDate: new Map() };

  // Orden por ventana para asignación rápida.
  const sorted = [...events].sort((a, b) => a.eligibleStartMs - b.eligibleStartMs);

  const sessions = db.prepare(`
    SELECT id, LOWER(wallet_address) AS wallet, entry_time, exit_time, auto_closed
    FROM sessions
    WHERE wallet_address IS NOT NULL
  `).all();

  // Estructura por evento: agrupar sesiones de cada wallet en una asistencia.
  const byDate = new Map(); // event_date -> { event, walletSpans: Map(wallet -> {firstEntryMs,lastExitMs,open}) , sessions:[{entryMs,exitMs}] }
  events.forEach(ev => byDate.set(ev.event_date, { event: ev, walletSpans: new Map(), spans: [] }));

  const now = Date.now();

  for (const s of sessions) {
    const entryMs = utcStrToMs(s.entry_time);
    if (entryMs == null) continue;
    // ¿A qué evento pertenece? (ventanas semanales no se solapan → primer match)
    const ev = sorted.find(e => entryMs >= e.eligibleStartMs && entryMs <= e.endMs);
    if (!ev) continue;

    // Salida real: timestamp si existe; si sigue abierta se considera dentro hasta
    // el cierre del evento (o "ahora" si el evento aún no ha terminado).
    let exitMs = utcStrToMs(s.exit_time);
    if (exitMs == null) exitMs = Math.min(ev.endMs, Math.max(now, entryMs));
    if (exitMs < entryMs) exitMs = entryMs;

    const bucket = byDate.get(ev.event_date);
    bucket.spans.push({ entryMs, exitMs });

    const prev = bucket.walletSpans.get(s.wallet);
    if (!prev) {
      bucket.walletSpans.set(s.wallet, { firstEntryMs: entryMs, lastExitMs: exitMs });
    } else {
      if (entryMs < prev.firstEntryMs) prev.firstEntryMs = entryMs;
      if (exitMs > prev.lastExitMs) prev.lastExitMs = exitMs;
    }
  }

  // Primera asistencia histórica de cada wallet (para nuevos vs recurrentes).
  const walletFirstDate = new Map();
  for (const ev of events) {
    const bucket = byDate.get(ev.event_date);
    for (const wallet of bucket.walletSpans.keys()) {
      const cur = walletFirstDate.get(wallet);
      if (!cur || ev.event_date < cur) walletFirstDate.set(wallet, ev.event_date);
    }
  }

  return { events, byDate, walletFirstDate };
}

// Métricas agregadas de un evento a partir de su bucket.
function summarizeEvent(ev, bucket, walletFirstDate) {
  const attendees = bucket.walletSpans.size;
  let nuevos = 0;
  const stays = [];
  for (const [wallet, span] of bucket.walletSpans) {
    if (walletFirstDate.get(wallet) === ev.event_date) nuevos++;
    const mins = Math.round((span.lastExitMs - span.firstEntryMs) / 60000);
    if (mins > 0 && mins <= MAX_STAY_MIN) stays.push(mins);
  }
  const avgStay = stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null;

  // Pico de aforo: máximo de spans solapados (barrido de eventos entrada/salida).
  const peakInside = computePeak(bucket.spans);

  return {
    event_date: ev.event_date,
    title: ev.title,
    start_time: ev.start_time,
    end_time: ev.end_time,
    attendees,
    nuevos,
    recurrentes: attendees - nuevos,
    avg_stay: avgStay,
    peak_inside: peakInside
  };
}

// Concurrencia máxima a partir de intervalos [entrada, salida).
function computePeak(spans) {
  if (!spans.length) return 0;
  const points = [];
  spans.forEach(s => {
    points.push({ t: s.entryMs, delta: 1 });
    points.push({ t: s.exitMs, delta: -1 });
  });
  // Salidas antes que entradas en el mismo instante para no inflar el pico.
  points.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let cur = 0, peak = 0;
  for (const p of points) { cur += p.delta; if (cur > peak) peak = cur; }
  return peak;
}

// ── API pública ──────────────────────────────────────────────────────────────

// Resumen por evento + globales. Alimenta el panel y otros endpoints.
function getOverview() {
  const { events, byDate, walletFirstDate } = analyze();
  const perEvent = events.map(ev => summarizeEvent(ev, byDate.get(ev.event_date), walletFirstDate));

  // Solo eventos que ya ocurrieron (tienen al menos una asistencia) para los totales.
  const withData = perEvent.filter(e => e.attendees > 0);

  const totalUniqueAttendees = walletFirstDate.size;
  const todayMadrid = madridParts(Date.now()).date;
  const monthStr = todayMadrid.slice(0, 7);
  const prevMonthStr = (() => {
    const [yy, mm] = monthStr.split('-').map(Number);
    const d = new Date(Date.UTC(yy, mm - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();

  let newThisMonth = 0, newLastMonth = 0;
  for (const date of walletFirstDate.values()) {
    if (date.slice(0, 7) === monthStr) newThisMonth++;
    else if (date.slice(0, 7) === prevMonthStr) newLastMonth++;
  }

  const bestEvent = withData.reduce((a, b) => (b.attendees > (a?.attendees || 0) ? b : a), null);
  const avgAttendees = withData.length
    ? Math.round(withData.reduce((s, e) => s + e.attendees, 0) / withData.length * 10) / 10
    : 0;

  return {
    perEvent,                 // todos (incluye futuros con 0)
    pastEvents: withData,     // solo los que ya ocurrieron
    community: getCommunityGrowth(),  // nuevos usuarios cualquier día (≠ asistencia)
    totals: {
      total_unique_attendees: totalUniqueAttendees,
      events_held: withData.length,
      avg_attendees_per_event: avgAttendees,
      best_event: bestEvent,
      new_this_month: newThisMonth,
      new_last_month: newLastMonth,
      growth_pct: newLastMonth > 0 ? Math.round((newThisMonth - newLastMonth) / newLastMonth * 100) : null,
      active_now: getActiveNow()
    }
  };
}

// Gente dentro AHORA (sesiones abiertas dentro de la ventana del evento activo).
function getActiveNow() {
  const events = getRealEvents();
  const now = Date.now();
  const live = events.find(e => now >= e.eligibleStartMs && now <= e.endMs);
  if (!live) return 0;
  const open = db.prepare(`SELECT LOWER(wallet_address) AS wallet, entry_time FROM sessions WHERE exit_time IS NULL`).all();
  const inside = new Set();
  open.forEach(s => {
    const entryMs = utcStrToMs(s.entry_time);
    if (entryMs != null && entryMs >= live.eligibleStartMs && entryMs <= live.endMs) inside.add(s.wallet);
  });
  return inside.size;
}

// Detalle horario de UN evento (para el gráfico "Aforo por hora").
function getEventDetail(eventDate) {
  const { events, byDate } = analyze();
  const ev = events.find(e => e.event_date === eventDate);
  if (!ev) return null;
  const bucket = byDate.get(eventDate);
  return buildHourly(ev, bucket.spans, [bucket]);
}

// Detalle horario PROMEDIO de todos los eventos celebrados (para "totales").
function getTotalsDetail() {
  const { events, byDate } = analyze();
  const buckets = events.map(e => byDate.get(e.event_date)).filter(b => b.spans.length > 0);
  if (!buckets.length) {
    return { date: 'totales', hours_range: [], entries_by_hour: [], exits_by_hour: [], inside_by_hour: [], max_inside: 0, avg_duration: null, total_entries: 0, peak_hour: null, raffle_hours: [] };
  }
  // Rango horario que cubra todos los eventos.
  const allHours = new Set();
  buckets.forEach(b => buildHourly(b.event, b.spans, [b]).hours_range.forEach(h => allHours.add(h)));
  const hoursRange = [...allHours].sort((a, b) => a - b);

  // Promediar por hora dividiendo entre el nº de eventos celebrados.
  const n = buckets.length;
  const sumEntries = {}, sumExits = {}, sumInside = {};
  let allStays = [], totalEntries = 0;
  buckets.forEach(b => {
    const d = buildHourly(b.event, b.spans, [b]);
    d.entries_by_hour.forEach(x => { sumEntries[x.hour] = (sumEntries[x.hour] || 0) + x.count; });
    d.exits_by_hour.forEach(x => { sumExits[x.hour] = (sumExits[x.hour] || 0) + x.count; });
    d.inside_by_hour.forEach(x => { sumInside[x.hour] = (sumInside[x.hour] || 0) + x.count; });
    totalEntries += d.total_entries;
    if (d._stays) allStays = allStays.concat(d._stays);
  });
  const avg = o => hoursRange.map(h => ({ hour: h, count: Math.round((o[h] || 0) / n * 10) / 10 }));
  const entries_by_hour = avg(sumEntries);
  const inside_by_hour = avg(sumInside);
  const peakEntry = entries_by_hour.reduce((a, b) => (b.count > (a?.count || 0) ? b : a), null);

  // Pico real máximo alcanzado en CUALQUIER evento individual (no el promedio).
  const maxInside = Math.max(...buckets.map(b => computePeak(b.spans)), 0);
  const avgDuration = allStays.length ? Math.round(allStays.reduce((a, b) => a + b, 0) / allStays.length) : null;

  return {
    date: 'totales',
    hours_range: hoursRange,
    entries_by_hour,
    exits_by_hour: avg(sumExits),
    inside_by_hour,
    max_inside: maxInside,
    avg_duration: avgDuration,
    total_entries: Math.round(totalEntries / n * 10) / 10,
    peak_hour: peakEntry ? peakEntry.hour : null,
    raffle_hours: getRaffleHours(null)
  };
}

// Construye las series por hora (entradas, salidas, aforo dentro) de un evento.
function buildHourly(ev, spans, buckets) {
  // Rango de horas Madrid que cubre la ventana (maneja cruce de medianoche).
  const startH = ev.startHour;
  let endH = ev.endHour;
  // Si cruza medianoche, extiende 0..endH como 24..(24+endH)
  const crosses = ev.endMs - ev.startMs > 24 * 60 * 60 * 1000 - 1 ? false : (ev.endHour <= ev.startHour);
  const hours = [];
  const from = Math.max(0, startH - 1); // incluye el margen de 1h antes
  if (crosses) {
    for (let h = from; h <= 23; h++) hours.push(h);
    for (let h = 0; h <= endH; h++) hours.push(h);
  } else {
    for (let h = from; h <= endH; h++) hours.push(h);
  }

  const entryCount = {}, exitCount = {};
  const stays = [];
  spans.forEach(s => {
    const ep = madridParts(s.entryMs);
    entryCount[ep.hour] = (entryCount[ep.hour] || 0) + 1;
    if (s.exitMs != null) {
      const xp = madridParts(s.exitMs);
      exitCount[xp.hour] = (exitCount[xp.hour] || 0) + 1;
    }
    const mins = Math.round((s.exitMs - s.entryMs) / 60000);
    if (mins > 0 && mins <= MAX_STAY_MIN) stays.push(mins);
  });

  // Aforo dentro al final de cada hora (gente con entry<=fin_hora<exit).
  const inside_by_hour = hours.map(h => {
    // instante = fin de esa hora Madrid del día del evento (o día siguiente si >=24 lógico)
    const sampleMs = hourSampleMs(ev, h);
    let c = 0;
    spans.forEach(s => { if (s.entryMs <= sampleMs && s.exitMs > sampleMs) c++; });
    return { hour: h, count: c };
  });

  const entries_by_hour = hours.map(h => ({ hour: h, count: entryCount[h] || 0 }));
  const exits_by_hour = hours.map(h => ({ hour: h, count: exitCount[h] || 0 }));
  const total_entries = spans.length;
  const max_inside = computePeak(spans);
  const avg_duration = stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null;
  const peakEntry = entries_by_hour.reduce((a, b) => (b.count > (a?.count || 0) ? b : a), null);

  return {
    date: ev.event_date,
    hours_range: hours,
    entries_by_hour,
    exits_by_hour,
    inside_by_hour,
    max_inside,
    avg_duration,
    total_entries,
    peak_hour: peakEntry ? peakEntry.hour : null,
    raffle_hours: getRaffleHours(ev.event_date),
    _stays: stays
  };
}

// Instante UTC (ms) que corresponde al final de la hora `h` (Madrid) del evento.
function hourSampleMs(ev, h) {
  const [y, mo, d] = ev.event_date.split('-').map(Number);
  // Horas < startHour-? que en realidad son del día siguiente (cruce de medianoche)
  let dayOffset = 0;
  if (ev.endHour <= ev.startHour && h <= ev.endHour) dayOffset = 1;
  const base = new Date(Date.UTC(y, mo - 1, d));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return madridWallToMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, 59);
}

// Horas (Madrid) a las que se lanzaron sorteos — para marcar ⚡ en el gráfico.
function getRaffleHours(eventDate) {
  let rows;
  if (eventDate) {
    rows = db.prepare(`SELECT created_at FROM raffles`).all()
      .filter(r => madridParts(utcStrToMs(r.created_at) || 0).date === eventDate);
  } else {
    rows = db.prepare(`SELECT created_at FROM raffles`).all();
  }
  const hours = new Set();
  rows.forEach(r => { const ms = utcStrToMs(r.created_at); if (ms != null) hours.add(madridParts(ms).hour); });
  return [...hours].sort((a, b) => a - b).map(hour => ({ hour }));
}

// ── Derivados canónicos para reutilizar en otros endpoints ───────────────────

// Asistentes por día de evento (reemplaza las distintas "visitas por día").
function getAttendanceByDate() {
  const { events, byDate, walletFirstDate } = analyze();
  return events
    .map(ev => summarizeEvent(ev, byDate.get(ev.event_date), walletFirstDate))
    .filter(e => e.attendees > 0)
    .sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
}

// Nuevos por evento (para el funnel) — misma definición que el resto.
function getNewByEvent() {
  return getAttendanceByDate().map(e => ({ event_date: e.event_date, new_clients: e.nuevos }));
}

// ── Crecimiento de comunidad (NUEVOS USUARIOS cualquier día) ────────────────
// OJO: esto es distinto de "nuevos asistentes". La asistencia solo cuenta en días
// de evento y su horario, pero un usuario puede darse de ALTA cualquier día de la
// semana (mint, instalar la app/push, apuntarse a un RSVP, fichar...). Aquí medimos
// el alta = primera vez que la wallet aparece por CUALQUIER vía, sin importar el día.
function _prevMonth(monthStr) {
  const [yy, mm] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(yy, mm - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getCommunityGrowth() {
  const rows = db.prepare(`
    SELECT wallet, MIN(ts) AS first_seen FROM (
      SELECT LOWER(wallet_address) AS wallet, minted_at AS ts FROM mints WHERE status != 'failed' AND wallet_address IS NOT NULL
      UNION ALL SELECT LOWER(wallet_address), entry_time      FROM sessions            WHERE wallet_address IS NOT NULL
      UNION ALL SELECT LOWER(wallet_address), visited_at      FROM visits              WHERE wallet_address IS NOT NULL
      UNION ALL SELECT LOWER(wallet_address), created_at      FROM push_subscriptions  WHERE wallet_address IS NOT NULL
      UNION ALL SELECT LOWER(wallet_address), created_at      FROM rsvps               WHERE wallet_address IS NOT NULL
      UNION ALL SELECT LOWER(wallet_address), claimed_at      FROM weekly_claims       WHERE wallet_address IS NOT NULL
    ) GROUP BY wallet
  `).all();

  const monthStr = madridParts(Date.now()).date.slice(0, 7);
  const prevStr = _prevMonth(monthStr);
  const byDay = {}, byMonth = {};
  let total = 0, thisMonth = 0, lastMonth = 0;

  rows.forEach(r => {
    const ms = utcStrToMs(r.first_seen);
    if (ms == null) return;
    const day = madridParts(ms).date;       // fecha Madrid del alta
    const mo = day.slice(0, 7);
    byDay[day] = (byDay[day] || 0) + 1;
    byMonth[mo] = (byMonth[mo] || 0) + 1;
    total++;
    if (mo === monthStr) thisMonth++; else if (mo === prevStr) lastMonth++;
  });

  const new_by_day = Object.entries(byDay)
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  const new_by_month = Object.entries(byMonth)
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  return {
    total_users: total,
    new_this_month: thisMonth,
    new_last_month: lastMonth,
    growth_pct: lastMonth > 0 ? Math.round((thisMonth - lastMonth) / lastMonth * 100) : null,
    new_by_day,
    new_by_month
  };
}

// Wallets que asistieron a cada evento, en minúsculas: { 'YYYY-MM-DD': [wallet,...] }.
// Para cruzar con RSVP (ganas vs aparición real) con la misma definición de asistencia.
function getAttendeeWalletsByDate() {
  const { events, byDate } = analyze();
  const out = {};
  events.forEach(ev => {
    out[ev.event_date] = [...byDate.get(ev.event_date).walletSpans.keys()];
  });
  return out;
}

// Estadísticas de visita canónicas para getStats (total, únicos, por día).
function getVisitStats() {
  const byDate = getAttendanceByDate();
  const totalVisits = byDate.reduce((s, e) => s + e.attendees, 0);
  const { walletFirstDate } = analyze();
  return {
    totalVisits,
    uniqueVisitors: walletFirstDate.size,
    visitsByDay: byDate.map(e => ({ day: e.event_date, count: e.attendees }))
  };
}

// Presentes AHORA en el local, desglosados por NIVEL efectivo y por LOGRO NFT.
// "Presente" = misma definición que el aforo en vivo / elegibles de sorteo
// (fichó entrada en la ventana del evento y no ha fichado salida).
function getPresentByLevel() {
  const { getEligibleRaffleParticipants } = require('../db/database');
  const present = (getEligibleRaffleParticipants() || []).map(w => String(w).toLowerCase());
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const byAchievement = {};
  if (!present.length) return { total: 0, byLevel, byAchievement };
  const presentSet = new Set(present);
  // Nivel efectivo: MAX nivel minteado; sin mint = Nv1 implícito.
  const lvlRows = db.prepare(`SELECT LOWER(wallet_address) w, MAX(level) lvl FROM mints WHERE status != 'failed' GROUP BY LOWER(wallet_address)`).all();
  const lvlMap = {};
  lvlRows.forEach(r => { lvlMap[r.w] = r.lvl; });
  present.forEach(w => { const lvl = lvlMap[w] || 1; if (byLevel[lvl] != null) byLevel[lvl]++; });
  // Logros NFT presentes (no fallidos).
  const achRows = db.prepare(`SELECT achievement_id, LOWER(wallet_address) w FROM achievement_mints WHERE status != 'failed'`).all();
  achRows.forEach(r => { if (presentSet.has(r.w)) byAchievement[r.achievement_id] = (byAchievement[r.achievement_id] || 0) + 1; });
  return { total: present.length, byLevel, byAchievement };
}

// ── INFORME DE NEGOCIO (rango de fechas + comparativa con el periodo anterior) ──
// Cruza las TRES fuentes con las definiciones canónicas de arriba:
//   · afluencia (sessions→eventos)  · comunidad (altas)  · facturación (event_finances).
// La adopción de la app = fichajes de la app vs comensales reales (covers) apuntados
// en la facturación de cada evento — solo en eventos que tienen ambos datos.

function _ymdAddDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function _ymdDiffDays(a, b) { // días de a→b inclusive
  const toMs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toMs(b) - toMs(a)) / 86400000) + 1;
}
function _pctDelta(cur, prev) {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? 0 : null; // sin base no hay %
  return Math.round((cur - prev) / Math.abs(prev) * 1000) / 10;
}
function _round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

function _summarizeRange(from, to, ctx) {
  const inRange = (d) => d >= from && d <= to;

  // ── Afluencia: eventos del rango ya celebrados (con fichajes) ──
  const rangeEvents = ctx.events.filter(ev => inRange(ev.event_date));
  const uniques = new Set();
  const stays = [];
  let asistencias = 0, nuevos = 0, peakMax = 0, peakSum = 0;
  const perEvent = [];
  for (const ev of rangeEvents) {
    const bucket = ctx.byDate.get(ev.event_date);
    const sum = summarizeEvent(ev, bucket, ctx.walletFirstDate);
    if (sum.attendees === 0) continue; // futuro o sin datos
    asistencias += sum.attendees;
    nuevos += sum.nuevos;
    peakMax = Math.max(peakMax, sum.peak_inside);
    peakSum += sum.peak_inside;
    for (const [wallet, span] of bucket.walletSpans) {
      uniques.add(wallet);
      const mins = Math.round((span.lastExitMs - span.firstEntryMs) / 60000);
      if (mins > 0 && mins <= MAX_STAY_MIN) stays.push(mins);
    }
    perEvent.push(sum);
  }
  const eventsHeld = perEvent.length;
  const avgStay = stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null;

  // ── Comunidad: altas de usuarios en el rango (cualquier vía, cualquier día) ──
  let newSignups = 0;
  ctx.community.new_by_day.forEach(x => { if (inRange(x.day)) newSignups += x.count; });

  // ── Facturación: eventos del rango con datos económicos ──
  const finRows = ctx.finance.events.filter(f => inRange(f.date));
  let revenue = null, costs = null, covers = 0, vip = 0, revenueEvents = 0;
  const costsByCategory = { staff: 0, dj: 0, band: 0, fnb: 0, decor: 0, other: 0 };
  finRows.forEach(f => {
    if (f.revenue != null) { revenue = (revenue || 0) + f.revenue; revenueEvents++; }
    if (f.costsTotal != null) costs = (costs || 0) + f.costsTotal;
    Object.keys(costsByCategory).forEach(k => { if (f.costs && f.costs[k]) costsByCategory[k] += f.costs[k]; });
    if (f.covers) covers += f.covers;
    if (f.vipCount) vip += f.vipCount;
  });
  const profit = revenue != null ? revenue - (costs || 0) : null;
  const marginPct = (profit != null && revenue > 0) ? _round1(profit / revenue * 100) : null;
  const avgTicket = (revenue != null && covers > 0) ? _round1(revenue / covers) : null;

  // ── Adopción de la app: fichajes vs comensales reales, solo eventos con ambos ──
  const attByDate = {};
  perEvent.forEach(e => { attByDate[e.event_date] = e.attendees; });
  let adoptCovers = 0, adoptApp = 0, adoptEvents = 0;
  finRows.forEach(f => {
    if (f.covers > 0 && attByDate[f.date] != null) {
      adoptCovers += f.covers;
      adoptApp += attByDate[f.date];
      adoptEvents++;
    }
  });
  const adoptionPct = adoptCovers > 0 ? _round1(adoptApp / adoptCovers * 100) : null;

  // ── Sorteos lanzados en el rango (fecha Madrid) ──
  let raffles = 0;
  ctx.raffleDates.forEach(d => { if (inRange(d)) raffles++; });

  // Detalle por evento: afluencia + facturación fusionadas por fecha
  const finByDate = {};
  finRows.forEach(f => { finByDate[f.date] = f; });
  const detail = perEvent.map(e => {
    const f = finByDate[e.event_date] || {};
    return {
      date: e.event_date, title: e.title,
      attendees: e.attendees, nuevos: e.nuevos, recurrentes: e.recurrentes,
      avg_stay: e.avg_stay, peak: e.peak_inside,
      covers: f.covers ?? null, revenue: f.revenue ?? null,
      costsTotal: f.costsTotal ?? null, profit: f.profit ?? null, marginPct: _round1(f.marginPct),
      avgTicket: _round1(f.avgTicket),
      adoptionPct: (f.covers > 0) ? _round1(e.attendees / f.covers * 100) : null
    };
  });

  return {
    from, to,
    events_held: eventsHeld,
    asistencias,
    unicos: uniques.size,
    nuevos,
    recurrentes: asistencias - nuevos,
    recurrencia_pct: asistencias > 0 ? _round1((asistencias - nuevos) / asistencias * 100) : null,
    avg_attendees: eventsHeld ? _round1(asistencias / eventsHeld) : null,
    avg_stay: avgStay,
    peak_max: peakMax,
    peak_avg: eventsHeld ? _round1(peakSum / eventsHeld) : null,
    new_signups: newSignups,
    raffles,
    revenue, costs, profit, marginPct,
    covers: finRows.length ? covers : null,
    vip: finRows.length ? vip : null,
    revenueEvents,
    avgTicket, costsByCategory,
    adoption: { pct: adoptionPct, app: adoptApp, covers: adoptCovers, events: adoptEvents },
    detail
  };
}

function getBusinessReport(from, to) {
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const today = madridParts(Date.now()).date;
  if (!YMD_RE.test(to || '')) to = today;
  if (!YMD_RE.test(from || '')) from = _ymdAddDays(to, -29);
  if (from > to) { const t = from; from = to; to = t; }

  const { events, byDate, walletFirstDate } = analyze();
  const community = getCommunityGrowth();
  const finance = require('../db/database').getEventFinancesSummary();
  const raffleDates = db.prepare(`SELECT created_at FROM raffles`).all()
    .map(r => { const ms = utcStrToMs(r.created_at); return ms != null ? madridParts(ms).date : null; })
    .filter(Boolean);
  const ctx = { events, byDate, walletFirstDate, community, finance, raffleDates };

  const len = _ymdDiffDays(from, to);
  const prevTo = _ymdAddDays(from, -1);
  const prevFrom = _ymdAddDays(prevTo, -(len - 1));

  const current = _summarizeRange(from, to, ctx);
  const previous = _summarizeRange(prevFrom, prevTo, ctx);

  // Deltas % de los indicadores comparables (null = sin base para comparar)
  const deltas = {};
  ['events_held', 'asistencias', 'unicos', 'nuevos', 'recurrentes', 'avg_attendees', 'avg_stay',
   'peak_max', 'new_signups', 'raffles', 'revenue', 'costs', 'profit', 'covers', 'avgTicket']
    .forEach(k => { deltas[k] = _pctDelta(current[k], previous[k]); });
  deltas.marginPct = (current.marginPct != null && previous.marginPct != null)
    ? _round1(current.marginPct - previous.marginPct) : null;   // puntos, no %
  deltas.adoptionPct = (current.adoption.pct != null && previous.adoption.pct != null)
    ? _round1(current.adoption.pct - previous.adoption.pct) : null; // puntos

  return {
    generated_at: new Date().toISOString(),
    total_users: community.total_users, // comunidad total histórica (contexto)
    current, previous, deltas
  };
}

module.exports = {
  getRealEvents,
  getOverview,
  getActiveNow,
  getPresentByLevel,
  getEventDetail,
  getTotalsDetail,
  getAttendanceByDate,
  getNewByEvent,
  getAttendeeWalletsByDate,
  getCommunityGrowth,
  getVisitStats,
  getBusinessReport,
  // helpers expuestos por si hacen falta en tests/otros módulos
  _internal: { madridWallToMs, madridParts, utcStrToMs, computePeak }
};
