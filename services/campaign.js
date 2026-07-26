// ─────────────────────────────────────────────────────────────────────────────
//  CAMPAÑA "EL RETO DE LOS 5" — Fidelización verano 2026
//
//  El Furancho cierra por vacaciones (agosto + parte de septiembre). Durante ese
//  periodo se premia la constancia: 5 visitas = NFT exclusivo "Furancho Legend 2026".
//
//  REGLAS FUNDAMENTALES:
//  · Es INDEPENDIENTE del fichaje normal y de los niveles (Nv1–Nv4). NO interfiere.
//  · 1 visita de campaña por cliente por día natural (Madrid). Idempotente.
//  · Los DÍAS CON EVENTO FURANCHO ACTIVO no cuentan como visita de campaña: ese día
//    el cliente viene a la sesión, no a la terraza de verano.
//  · Al llegar a 5 visitas, el logro queda en 'pending_approval' hasta que el admin
//    lo confirme antes de mintear (evita gas por trampas).
//  · Más allá de 5, se sigue acumulando: el total decide los privilegios en septiembre.
// ─────────────────────────────────────────────────────────────────────────────

const {
  recordCampaignVisit, getCampaignVisitCount, getCampaignLeaderboard,
  getCampaignStats, claimAchievement, getAchievementMint
} = require('../db/database');
const achievements = require('./achievements');

const CAMPAIGN = {
  id: 'reto_5_verano_2026',
  name: 'El Reto de los 5',
  startDate: '2026-07-22',   // inclusive
  endDate: '2026-09-20',     // inclusive
  requiredVisits: 5,
  achievementId: 'furancho_legend_2026'
};

// Tolerancia de frescura del QR en vivo (segundos). Una captura caduca pasado esto.
const QR_MAX_AGE_SECONDS = 120;

// Fecha YYYY-MM-DD en hora Madrid (misma convención que el resto del sistema).
function madridDateStr(d = new Date()) {
  const madrid = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const yyyy = madrid.getFullYear();
  const mm = String(madrid.getMonth() + 1).padStart(2, '0');
  const dd = String(madrid.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ¿Estamos dentro del periodo de campaña? (comparación de fechas Madrid, inclusive)
function isCampaignActive(d = new Date()) {
  const today = madridDateStr(d);
  return today >= CAMPAIGN.startDate && today <= CAMPAIGN.endDate;
}

// ¿Hay un evento Furancho activo HOY? Los días de Furancho NO cuentan como visita
// de campaña: el cliente viene a la sesión, no a la terraza de verano.
function isFuranchoDayToday(d = new Date()) {
  try {
    const { db } = require('../db/database');
    const today = madridDateStr(d);
    const ev = db.prepare(
      `SELECT id FROM events WHERE event_date = ? AND active = 1 LIMIT 1`
    ).get(today);
    return !!ev;
  } catch { return false; }
}

// Valida que el timestamp del QR en vivo es reciente (no una captura vieja).
// tsSeconds: unix seconds embebido en el QR (CAMPAIGN:wallet:ts). Devuelve true si fresco.
function isQrFresh(tsSeconds, d = new Date()) {
  const ts = parseInt(tsSeconds, 10);
  if (!ts || isNaN(ts)) return false;
  const nowSec = Math.floor(d.getTime() / 1000);
  const age = Math.abs(nowSec - ts);
  return age <= QR_MAX_AGE_SECONDS;
}

// Obtener la tabla de privilegios dinámica (leyendo overrides de app_settings para +5 y +10).
function getPrivilegeTiers() {
  const { getSetting, getCampaignStats } = require('../db/database');
  
  let perks5 = ['NFT Furancho Legend 2026 (requiere aprobación admin)', 'Descuento en la primera consumición de septiembre'];
  let perks10 = ['Mesa VIP garantizada en el 1er Furancho de septiembre', 'Botella de albariño de bienvenida', 'Mención especial en el tablón del Furancho'];

  // Calcular las plazas restantes para el descuento de las 5 visitas (solo 5 primeros)
  let discountText = '🎟️ Descuento en tu primera consumición de septiembre';
  try {
    const stats5 = getCampaignStats(5, CAMPAIGN.id);
    const completed5 = stats5 ? stats5.completed : 0;
    const remaining5 = Math.max(0, 5 - completed5);
    if (remaining5 > 0) {
      discountText = `🎟️ Descuento en consumición en septiembre (¡solo quedan ${remaining5} plaza${remaining5 !== 1 ? 's' : ''}!)`;
    } else {
      discountText = `🎟️ Descuento de consumición agotado (5/5 reclamados)`;
    }
  } catch (e) {}

  // Reemplazar el texto base del descuento
  const idxDesc = perks5.findIndex(p => p.includes('Descuento en la primera consumición'));
  if (idxDesc !== -1) perks5[idxDesc] = discountText;

  // Calcular las plazas restantes para la cata en 10 visitas (solo 1º primero)
  let tastingText = '🍷 Plaza garantizada para la cata exclusiva (¡solo 1 plaza!)';
  try {
    const stats10 = getCampaignStats(10, CAMPAIGN.id);
    const completed10 = stats10 ? stats10.completed : 0;
    const remaining10 = Math.max(0, 1 - completed10);
    if (remaining10 > 0) {
      tastingText = `🍷 Plaza para cata exclusiva (¡solo queda ${remaining10} plaza!)`;
    } else {
      tastingText = `🍷 Plazas de cata agotadas (1/1 cubiertas)`;
    }
  } catch (e) {}

  perks10.unshift(tastingText);
  perks10.unshift('NFT Furancho Legend Oro 2026');

  try {
    const raw5 = getSetting('campaign_privileges_5');
    if (raw5) {
      const parsed = JSON.parse(raw5);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Mantenemos la lógica viva
        perks5 = [discountText, ...parsed.filter(p => !p.includes('Descuento en la primera consumición'))];
      }
    }
  } catch (_) {}

  try {
    const raw10 = getSetting('campaign_privileges_10');
    if (raw10) {
      const parsed = JSON.parse(raw10);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Mantenemos la lógica viva
        perks10 = [tastingText, ...parsed.filter(p => !p.includes('cata exclusiva'))];
      }
    }
  } catch (_) {}

  return [
    { minVisits: 10, emoji: '👑', label: 'Presidente da Terraza (Nivel Oro)', perks: perks10 },
    { minVisits: 5,  emoji: '🏅', label: 'Veterano da Terraza',   perks: perks5 },
  ];
}


function savePrivileges(perks5, perks10) {
  const { setSetting } = require('../db/database');
  if (Array.isArray(perks5)) {
    setSetting('campaign_privileges_5', JSON.stringify(perks5.map(s => String(s).trim()).filter(Boolean)));
  }
  if (Array.isArray(perks10)) {
    setSetting('campaign_privileges_10', JSON.stringify(perks10.map(s => String(s).trim()).filter(Boolean)));
  }
  return getPrivilegeTiers();
}

function getPrivilegeTier(visits) {
  const tiers = getPrivilegeTiers();
  for (const tier of tiers) {
    if (visits >= tier.minVisits) return { ...tier, visits };
  }
  return null;
}


// Núcleo: registra y reclama logro si procede. Compartido por todos los caminos.
function _doRecordVisit(walletAddress, dateStr) {
  const { counted, totalVisits } = recordCampaignVisit(walletAddress, dateStr, CAMPAIGN.id);
  const completed = totalVisits >= CAMPAIGN.requiredVisits;
  let claimStatus = null;

  if (counted) {
    try { require('./corcho').rewardCampaignVisit(walletAddress, dateStr); } catch (_) {}
  }


  // Reclamar NFT de 5 visitas (Furancho Legend base)
  if (totalVisits >= 5) {
    const a = achievements.getById(CAMPAIGN.achievementId);
    if (a) {
      const existing = getAchievementMint(walletAddress, a.id);
      if (!existing) {
        claimAchievement(walletAddress, a.id, a.tokenId, 'pending_approval');
      }
      const m = getAchievementMint(walletAddress, a.id);
      if (!claimStatus) claimStatus = m ? m.status : 'pending_approval';
    }
  }

  // Reclamar NFT de 10 visitas (Furancho Legend Oro)
  if (totalVisits >= 10) {
    const aOro = achievements.getById('furancho_legend_oro_2026');
    if (aOro) {
      const existing = getAchievementMint(walletAddress, aOro.id);
      if (!existing) {
        claimAchievement(walletAddress, aOro.id, aOro.tokenId, 'pending_approval');
      }
      const m = getAchievementMint(walletAddress, aOro.id);
      // Sobre-escribe el claimStatus para el UI para mostrar el progreso de Oro si ya superó el nivel 5
      claimStatus = m ? m.status : 'pending_approval';
    }
  }

  return {
    active: true,
    counted,
    totalVisits,
    required: CAMPAIGN.requiredVisits,
    completed,
    claimStatus,
    campaignName: CAMPAIGN.name,
    privilege: getPrivilegeTier(totalVisits)
  };
}

// Registra una visita de campaña para el cliente (idempotente por día).
// Si es día de Furancho, no cuenta — ese día el cliente viene a la sesión.
function recordVisit(walletAddress, d = new Date()) {
  if (!isCampaignActive(d)) {
    return { active: false, counted: false, totalVisits: getCampaignVisitCount(walletAddress) };
  }
  if (isFuranchoDayToday(d)) {
    const totalVisits = getCampaignVisitCount(walletAddress);
    return {
      active: true, counted: false, totalVisits,
      required: CAMPAIGN.requiredVisits, completed: totalVisits >= CAMPAIGN.requiredVisits,
      claimStatus: null, campaignName: CAMPAIGN.name,
      error: 'furancho_day',   // <── el día de sesión no cuenta para el reto de verano
      privilege: getPrivilegeTier(totalVisits)
    };
  }
  return _doRecordVisit(walletAddress, madridDateStr(d));
}

// Fichaje por QR en vivo (móvil del cliente → camarero / panel admin).
// Requiere timestamp fresco para evitar capturas reutilizadas.
function recordVisitFromScan(walletAddress, campaignTs, d = new Date()) {
  if (!isCampaignActive(d)) return null;
  if (campaignTs === undefined || campaignTs === null || campaignTs === '') {
    return { active: true, counted: false, error: 'qr_not_live' };
  }
  if (!isQrFresh(campaignTs, d)) {
    return { active: true, counted: false, error: 'qr_expired' };
  }
  return recordVisit(walletAddress, d);
}

// Fichaje manual por staff (sin QR en vivo). Solo para el camarero con código válido.
// No requiere QR fresco porque el staff es de confianza: ellos ven al cliente en persona.
// SÍ respeta la regla de día-de-Furancho y la idempotencia por día.
function recordVisitByStaff(walletAddress, d = new Date()) {
  if (!isCampaignActive(d)) {
    return { active: false, counted: false, totalVisits: getCampaignVisitCount(walletAddress) };
  }
  // Días de Furancho siguen sin contar, incluso si el staff lo solicita.
  return recordVisit(walletAddress, d);
}

// Progreso del cliente (para su app). No escribe nada.
function getProgress(walletAddress) {
  const visits = getCampaignVisitCount(walletAddress);
  let claimStatus = null;
  const a = achievements.getById(CAMPAIGN.achievementId);
  if (a) {
    const m = getAchievementMint(walletAddress, a.id);
    if (m) claimStatus = m.status;
  }
  const aOro = achievements.getById('furancho_legend_oro_2026');
  if (aOro && visits >= 10) {
    const mOro = getAchievementMint(walletAddress, aOro.id);
    if (mOro) claimStatus = mOro.status; // Sobre-escribe el claim status si tiene el oro
  }
  return {
    active: isCampaignActive(),
    campaignId: CAMPAIGN.id,
    campaignName: CAMPAIGN.name,
    visits,
    required: CAMPAIGN.requiredVisits,
    completed: visits >= CAMPAIGN.requiredVisits,
    claimStatus,
    startDate: CAMPAIGN.startDate,
    endDate: CAMPAIGN.endDate,
    privilege: getPrivilegeTier(visits),
    isFuranchoDay: isFuranchoDayToday(),    // avisa al cliente cuando hoy no computa
    privilegeTiers: getPrivilegeTiers()     // tabla completa dinámica (con overrides de +5 y +10)
  };
}


// Ranking para la pantalla del camarero.
function getLeaderboard(limit = 10) {
  return getCampaignLeaderboard(limit, CAMPAIGN.id).map(r => ({
    wallet: r.wallet_address,
    visits: r.visits,
    lastVisit: r.last_visit,
    completed: r.visits >= CAMPAIGN.requiredVisits
  }));
}

// Estadísticas para el panel admin.
function getStats() {
  const { participants, completed } = getCampaignStats(CAMPAIGN.requiredVisits, CAMPAIGN.id);
  return { participants, completed, required: CAMPAIGN.requiredVisits, active: isCampaignActive() };
}

module.exports = {
  CAMPAIGN,
  getPrivilegeTiers,
  savePrivileges,
  QR_MAX_AGE_SECONDS,
  madridDateStr,
  isCampaignActive,
  isFuranchoDayToday,
  isQrFresh,
  getPrivilegeTier,
  recordVisit,
  recordVisitFromScan,
  recordVisitByStaff,
  getProgress,
  getLeaderboard,
  getStats
};

