// Horario semanal de la terraza — FUENTE ÚNICA (lo editan admin Y staff desde la
// app; el cliente lo ve en su home). Guardado en app_settings ('terraza_hours'),
// que vive junto a la BD en el volumen persistente: sobrevive deploys.
const { getSetting, setSetting } = require('../db/database');

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const EMPTY_WEEK = () => DAY_NAMES.map(() => ({ open: false, from: '19:00', to: '23:00' }));

function getTerrazaHours() {
  try {
    const raw = getSetting('terraza_hours');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && Array.isArray(cfg.days) && cfg.days.length === 7) {
        return { days: cfg.days, note: cfg.note || '', updatedAt: cfg.updatedAt || null, updatedBy: cfg.updatedBy || null };
      }
    }
  } catch (_) {}
  return { days: EMPTY_WEEK(), note: '', updatedAt: null, updatedBy: null };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function saveTerrazaHours({ days, note }, updatedBy) {
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
  const cfg = {
    days: clean,
    note: String(note || '').trim().slice(0, 140),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'admin'
  };
  setSetting('terraza_hours', JSON.stringify(cfg));
  return cfg;
}

module.exports = { DAY_NAMES, getTerrazaHours, saveTerrazaHours };
