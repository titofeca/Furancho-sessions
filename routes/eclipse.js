const express = require('express');
const router = express.Router();

// ── Caché en memoria (2 horas) ──────────────────────────────────────────────
let _weatherCache = null;
let _weatherCacheTs = 0;
const CACHE_MS = 2 * 60 * 60 * 1000;

function interpretWmo(code, cloudPct) {
  if (code === 0)                   return { emoji: '☀️',  label: 'Despejado',             clarity: 'excellent' };
  if (code === 1)                   return { emoji: '🌤️', label: 'Casi despejado',          clarity: 'good' };
  if (code === 2)                   return { emoji: '⛅',  label: 'Parcialmente nuboso',    clarity: 'ok' };
  if (code === 3)                   return { emoji: '☁️',  label: 'Nublado',                clarity: 'poor' };
  if (code >= 45 && code <= 48)    return { emoji: '🌫️', label: 'Niebla',                 clarity: 'poor' };
  if (code >= 51 && code <= 67)    return { emoji: '🌧️', label: 'Lluvia',                 clarity: 'poor' };
  if (code >= 71 && code <= 77)    return { emoji: '🌨️', label: 'Nieve',                  clarity: 'poor' };
  if (code >= 80 && code <= 82)    return { emoji: '🌦️', label: 'Chubascos',              clarity: 'poor' };
  if (code >= 95)                   return { emoji: '⛈️', label: 'Tormenta',               clarity: 'poor' };
  if (cloudPct !== null && cloudPct !== undefined) {
    if (cloudPct < 20)  return { emoji: '☀️',  label: 'Despejado',          clarity: 'excellent' };
    if (cloudPct < 40)  return { emoji: '🌤️', label: 'Poco nuboso',         clarity: 'good' };
    if (cloudPct < 60)  return { emoji: '⛅',  label: 'Parcialmente nuboso', clarity: 'ok' };
    if (cloudPct < 80)  return { emoji: '🌥️', label: 'Muy nuboso',          clarity: 'poor' };
    return { emoji: '☁️', label: 'Cubierto', clarity: 'poor' };
  }
  return { emoji: '❓', label: 'Sin datos', clarity: 'unknown' };
}

function clarityInfo(clarity) {
  return {
    excellent: { text: 'Excelente para el eclipse', color: '#4ade80' },
    good:      { text: 'Bueno para el eclipse',     color: '#86efac' },
    ok:        { text: 'Aceptable, puede mejorar',  color: '#fb923c' },
    poor:      { text: 'Poco favorable',            color: '#f87171' },
    unknown:   { text: 'Sin datos aún',             color: '#94a3b8' },
  }[clarity] || { text: 'Sin datos', color: '#94a3b8' };
}

const LOCATIONS = [
  { id: 'coruña',   name: 'A Coruña · Paseo Marítimo', lat: 43.37, lon: -8.40 },
  { id: 'hercules', name: 'Torre de Hércules',          lat: 43.39, lon: -8.43 },
  { id: 'fisterra', name: 'Fisterra (Costa da Morte)',  lat: 42.91, lon: -9.26 },
  { id: 'pindo',    name: 'Monte Pindo / Carnota',      lat: 42.96, lon: -9.08 },
  { id: 'lugo',     name: 'Interior — Lugo',            lat: 43.01, lon: -7.55 },
];

const ECLIPSE_DATE = '2026-08-12';

async function fetchLoc(loc) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,cloudcover_mean,precipitation_probability_max` +
    `&timezone=Europe%2FMadrid` +
    `&start_date=${ECLIPSE_DATE}&end_date=${ECLIPSE_DATE}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const code     = data.daily?.weathercode?.[0]                    ?? null;
    const cloudPct = data.daily?.cloudcover_mean?.[0]                ?? null;
    const precPct  = data.daily?.precipitation_probability_max?.[0]  ?? null;
    const tMax     = data.daily?.temperature_2m_max?.[0]             ?? null;
    const tMin     = data.daily?.temperature_2m_min?.[0]             ?? null;
    const wx = interpretWmo(code, cloudPct);
    return { id: loc.id, name: loc.name, code, cloudPct, precPct, tMax, tMin,
             emoji: wx.emoji, label: wx.label, clarity: wx.clarity,
             clarityInfo: clarityInfo(wx.clarity) };
  } catch { return null; }
}

router.get('/weather', async (req, res) => {
  const now = new Date();
  const ecl = new Date('2026-08-12T20:26:00+02:00');
  const daysUntil = Math.ceil((ecl - now) / 86400000);

  if (daysUntil > 16) {
    return res.json({ available: false, daysUntil,
      message: `Previsión disponible en aprox. ${daysUntil - 16} días. Mostrando datos climáticos históricos.` });
  }

  if (_weatherCache && (Date.now() - _weatherCacheTs) < CACHE_MS) {
    return res.json(_weatherCache);
  }

  try {
    const results = (await Promise.all(LOCATIONS.map(fetchLoc))).filter(Boolean);
    if (!results.length) return res.json({ available: false, daysUntil,
      message: 'No se pudo obtener previsión. Inténtalo más tarde.' });

    const reliability = daysUntil <= 3 ? 'alta' : daysUntil <= 7 ? 'media' : 'orientativa';
    const payload = {
      available: true, daysUntil,
      fetchedAt: new Date().toISOString(), reliability,
      reliabilityLabel: { alta:'Previsión fiable (72h)', media:'Previsión estimada (7 días)', orientativa:'Previsión orientativa (>7 días)' }[reliability],
      reliabilityColor: { alta:'#4ade80', media:'#fb923c', orientativa:'#94a3b8' }[reliability],
      locations: results,
    };
    _weatherCache = payload; _weatherCacheTs = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('[eclipse/weather]', e.message);
    res.status(500).json({ available: false, error: e.message });
  }
});

module.exports = router;
