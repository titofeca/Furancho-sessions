// Horario semanal de la terraza — FUENTE ÚNICA (lo editan admin Y staff desde la
// app; el cliente lo ve en su home). Guardado en app_settings ('terraza_hours'),
// que vive junto a la BD en el volumen persistente: sobrevive deploys.
//
// Modelo: patrón semanal (7 días) + `overrides` por FECHA concreta (festivos,
// cierres puntuales, horarios especiales) que mandan sobre el patrón ese día.
// Las fechas pasadas se purgan solas al leer (se conserva la de ayer, por si un
// horario especial cruza medianoche y sigue abierto de madrugada).
const { getSetting, setSetting } = require('../db/database');

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const EMPTY_WEEK = () => DAY_NAMES.map(() => ({ open: false, from: '19:00', to: '23:00' }));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function madridDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }); // YYYY-MM-DD
}

function pruneOverrides(list) {
  const yesterday = madridDateStr(-1);
  return (Array.isArray(list) ? list : [])
    .filter(o => o && YMD.test(o.date || '') && o.date >= yesterday)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 60);
}

function getTerrazaHours() {
  try {
    const raw = getSetting('terraza_hours');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && Array.isArray(cfg.days) && cfg.days.length === 7) {
        return {
          days: cfg.days,
          overrides: pruneOverrides(cfg.overrides),
          note: cfg.note || '',
          updatedAt: cfg.updatedAt || null,
          updatedBy: cfg.updatedBy || null
        };
      }
    }
  } catch (_) {}
  return { days: EMPTY_WEEK(), overrides: [], note: '', updatedAt: null, updatedBy: null };
}

function saveTerrazaHours({ days, overrides, note }, updatedBy) {
  if (!Array.isArray(days) || days.length !== 7) throw new Error('Deben venir los 7 días de la semana');
  const clean = days.map((d, i) => {
    const open = !!d.open;
    const from = String(d.from || '').trim();
    const to = String(d.to || '').trim();
    if (open && (!HHMM.test(from) || !HHMM.test(to))) {
      throw new Error(`Horario inválido en ${DAY_NAMES[i]} (usa formato HH:MM)`);
    }
    return { open, from: open ? from : (HHMM.test(from) ? from : '19:00'), to: open ? to : (HHMM.test(to) ? to : '23:00') };
  });

  // Fechas concretas: validar, deduplicar por fecha (la última gana) y ordenar
  const seen = {};
  (Array.isArray(overrides) ? overrides : []).forEach(o => {
    if (!o) return;
    const date = String(o.date || '').trim();
    if (!YMD.test(date)) throw new Error(`Fecha inválida en días especiales: "${date}"`);
    const open = !!o.open;
    const from = String(o.from || '').trim();
    const to = String(o.to || '').trim();
    if (open && (!HHMM.test(from) || !HHMM.test(to))) {
      throw new Error(`Horario inválido en el día especial ${date} (usa formato HH:MM)`);
    }
    // Observación del día (ej: "Conciertos"): opcional, la ve el cliente junto al horario
    const dayNote = String(o.note || '').trim().slice(0, 80);
    seen[date] = { date, open, from: open ? from : '19:00', to: open ? to : '23:00', note: dayNote };
  });
  const cleanOverrides = pruneOverrides(Object.values(seen));

  const cfg = {
    days: clean,
    overrides: cleanOverrides,
    note: String(note || '').trim().slice(0, 140),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'admin'
  };
  setSetting('terraza_hours', JSON.stringify(cfg));
  return cfg;
}

module.exports = { DAY_NAMES, getTerrazaHours, saveTerrazaHours };
