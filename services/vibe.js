// Medidor de ambiente ("FOMO en vivo") — FUENTE ÚNICA de los tramos y del estado.
// El conteo reutiliza getEligibleRaffleParticipants() (fichados dentro de la ventana
// del evento y sin fichar salida): el MISMO número que el aforo del admin y los
// sorteos en vivo. No toca sesiones ni añade SQL nuevo de métricas.
//
// Los tramos son editables desde el panel admin (app_settings, clave 'vibe_config');
// si no hay nada guardado se usan estos por defecto.
const {
  getSetting, setSetting,
  getActiveEventWindow, getEligibleRaffleParticipants, EVENT_EARLY_MARGIN_MS
} = require('../db/database');

const DEFAULT_TIERS = [
  { min: 0,  emoji: '🍃', title: 'Ambiente tranquilo',    text: 'Se está de lujo: charla tranquila, cunca en mano y sitio de sobra. Ideal para venir sin agobios, ho.' },
  { min: 20, emoji: '🍷', title: 'Ambientillo agradable', text: 'Esto va cogiendo color: mesas animadas, risas y el viño corriendo. Apetece, ¿eh?' },
  { min: 40, emoji: '🎉', title: '¡Genial, divertido!',   text: 'Nivelazo de noche, neno: el furancho está que da gusto. Como tardes mucho, mañana te lo cuentan.' },
  { min: 60, emoji: '🔥', title: '¡AMBIENTAZO!',          text: '¡Esto está petado, carallo! La noche de la semana está pasando AQUÍ… y tú leyéndolo desde el sofá. 🏃' }
];

function getVibeConfig() {
  try {
    const raw = getSetting('vibe_config');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && Array.isArray(cfg.tiers) && cfg.tiers.length) {
        return { enabled: cfg.enabled !== false, tiers: cfg.tiers };
      }
    }
  } catch (_) {}
  return { enabled: true, tiers: DEFAULT_TIERS };
}

function saveVibeConfig({ enabled, tiers }) {
  if (!Array.isArray(tiers) || tiers.length < 2 || tiers.length > 6) {
    throw new Error('Debe haber entre 2 y 6 tramos');
  }
  const clean = tiers.map(t => ({
    min: parseInt(t.min),
    emoji: String(t.emoji || '🍷').slice(0, 8),
    title: String(t.title || '').trim().slice(0, 60),
    text: String(t.text || '').trim().slice(0, 220)
  }));
  clean.forEach((t, i) => {
    if (isNaN(t.min) || t.min < 0) throw new Error(`Umbral inválido en el tramo ${i + 1}`);
    if (i === 0 && t.min !== 0) throw new Error('El primer tramo debe empezar en 0 personas');
    if (i > 0 && t.min <= clean[i - 1].min) throw new Error('Los umbrales deben ir de menor a mayor');
    if (!t.title) throw new Error(`Falta el título del tramo ${i + 1}`);
  });
  setSetting('vibe_config', JSON.stringify({ enabled: !!enabled, tiers: clean }));
  return { enabled: !!enabled, tiers: clean };
}

// Estado actual para el CLIENTE. Deliberadamente NO expone el número exacto de
// personas: solo el tramo (emoji, título, texto y nivel para pintar el medidor).
function getVibeNow() {
  const cfg = getVibeConfig();
  if (!cfg.enabled) return { active: false };
  const win = getActiveEventWindow();
  if (!win || win.nowMs < (win.startMs - EVENT_EARLY_MARGIN_MS) || win.nowMs > win.endMs) {
    return { active: false };
  }
  const count = getEligibleRaffleParticipants().length;
  let tier = cfg.tiers[0];
  for (const t of cfg.tiers) if (count >= t.min) tier = t;
  return {
    active: true,
    emoji: tier.emoji, title: tier.title, text: tier.text,
    level: cfg.tiers.indexOf(tier) + 1,
    levels: cfg.tiers.length
  };
}

module.exports = { DEFAULT_TIERS, getVibeConfig, saveVibeConfig, getVibeNow };
