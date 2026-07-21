// ─────────────────────────────────────────────────────────────────────────────
//  CAMPAÑA "EL RETO DE LOS 5" — Fidelización verano 2026
//
//  El Furancho cierra por vacaciones (agosto + parte de septiembre). Durante ese
//  periodo se premia la constancia: 5 visitas = NFT exclusivo "Furancho Legend 2026".
//
//  · Es INDEPENDIENTE del fichaje normal y de los niveles (Nv1–Nv4). Usa su propia
//    tabla campaign_visits, con 1 visita por cliente por día natural (Madrid).
//  · Al llegar a 5 visitas, se auto-reclama el logro con estado 'pending_approval':
//    el NFT NO se mintea hasta que el admin lo confirme (evita gas por trampas).
//  · El QR del cliente se valida en vivo (timestamp con caducidad) para que una
//    captura reenviada no sume visitas.
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

// Valida que el timestamp del QR en vivo es reciente (no una captura vieja).
// tsSeconds: unix seconds embebido en el QR (CAMPAIGN:wallet:ts). Devuelve true si fresco.
function isQrFresh(tsSeconds, d = new Date()) {
  const ts = parseInt(tsSeconds, 10);
  if (!ts || isNaN(ts)) return false;
  const nowSec = Math.floor(d.getTime() / 1000);
  const age = Math.abs(nowSec - ts);
  return age <= QR_MAX_AGE_SECONDS;
}

// Registra una visita de campaña para el cliente (idempotente por día). Si al hacerlo
// alcanza el nº requerido, auto-reclama el logro en estado 'pending_approval'.
// Devuelve el resultado enriquecido para pintar en la app del camarero.
function recordVisit(walletAddress, d = new Date()) {
  if (!isCampaignActive(d)) {
    return { active: false, counted: false, totalVisits: getCampaignVisitCount(walletAddress) };
  }
  const dateStr = madridDateStr(d);
  const { counted, totalVisits } = recordCampaignVisit(walletAddress, dateStr, CAMPAIGN.id);
  const completed = totalVisits >= CAMPAIGN.requiredVisits;
  let claimStatus = null;

  if (completed) {
    // Auto-reclama el logro, pero retenido a espera de aprobación admin.
    const a = achievements.getById(CAMPAIGN.achievementId);
    if (a) {
      const existing = getAchievementMint(walletAddress, a.id);
      if (!existing) {
        claimAchievement(walletAddress, a.id, a.tokenId, 'pending_approval');
        console.log(`[Campaña] ${walletAddress.slice(0,8)}… completó el Reto de los 5 — logro en pending_approval`);
      }
      const m = getAchievementMint(walletAddress, a.id);
      claimStatus = m ? m.status : 'pending_approval';
    }
  }

  return {
    active: true,
    counted,                       // true = punto nuevo hoy; false = ya fichó hoy
    totalVisits,
    required: CAMPAIGN.requiredVisits,
    completed,
    claimStatus,                   // null | 'pending_approval' | 'pending' | 'success'
    campaignName: CAMPAIGN.name
  };
}

// Resultado de campaña para UN fichaje, venga del camarero (/staff) o del panel
// (Escáner del admin). FUENTE ÚNICA de la regla: si la campaña está en marcha, el QR
// tiene que ser el de "en vivo" (con timestamp fresco); una captura o el ID Socio
// clásico no suman visita. Así los dos caminos cuentan igual y nadie hace trampa
// por fichar desde un sitio u otro. Devuelve null si no hay campaña.
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

// Progreso del cliente (para su app). No escribe nada.
function getProgress(walletAddress) {
  const visits = getCampaignVisitCount(walletAddress);
  let claimStatus = null;
  const a = achievements.getById(CAMPAIGN.achievementId);
  if (a) {
    const m = getAchievementMint(walletAddress, a.id);
    claimStatus = m ? m.status : null;
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
    endDate: CAMPAIGN.endDate
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
  QR_MAX_AGE_SECONDS,
  madridDateStr,
  isCampaignActive,
  isQrFresh,
  recordVisit,
  recordVisitFromScan,
  getProgress,
  getLeaderboard,
  getStats
};
