// ─────────────────────────────────────────────────────────────────────────────
//  ELEGIBILIDAD DE SORTEOS — fuente única para Chave Semanal y sorteos nocturnos.
//
//  Un sorteo puede exigir: nivel mínimo (1-4) Y/O tener un logro NFT concreto.
//  Si se configuran ambos, hay que cumplir LOS DOS (AND). Devuelve siempre un motivo
//  legible para mostrar al cliente que "ve el sorteo pero no puede entrar".
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require('../db/database');
const achievements = require('./achievements');

const LEVEL_NAMES = { 1: 'Cautivo', 2: 'Cunqueiro', 3: 'Larpeiro', 4: 'Presidente' };

// Nivel efectivo de una wallet: máximo nivel con pase no fallido; si no tiene pase pero
// es furancheiro (tiene sesión/visita), cuenta como Nv1 implícito.
function walletMaxLevel(wallet) {
  if (!wallet) return 0;
  const lv = db.prepare(`SELECT MAX(level) lv FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND status != 'failed'`).get(wallet)?.lv;
  return lv || 1;
}

function walletHasAchievement(wallet, achievementId) {
  if (!achievementId) return true;
  if (!wallet) return false;
  const r = db.prepare(`SELECT 1 FROM achievement_mints WHERE LOWER(wallet_address) = LOWER(?) AND achievement_id = ? AND status != 'failed' LIMIT 1`).get(wallet, achievementId);
  return !!r;
}

// criteria = { minLevel, requiredAchievement }. Devuelve { eligible, reason }.
function checkEligibility(wallet, criteria = {}) {
  const minLevel = criteria.minLevel ? parseInt(criteria.minLevel) : null;
  const requiredAchievement = criteria.requiredAchievement || null;

  if (minLevel && walletMaxLevel(wallet) < minLevel) {
    return { eligible: false, reason: `Solo para Nv${minLevel}+ (${LEVEL_NAMES[minLevel] || ''})`.trim() };
  }
  if (requiredAchievement && !walletHasAchievement(wallet, requiredAchievement)) {
    const a = achievements.getById(requiredAchievement);
    return { eligible: false, reason: `Requiere el logro «${a ? a.name : requiredAchievement}»` };
  }
  return { eligible: true, reason: null };
}

// Texto del requisito (independiente de la wallet) para mostrar en la tarjeta del sorteo.
function requirementLabel(criteria = {}) {
  const minLevel = criteria.minLevel ? parseInt(criteria.minLevel) : null;
  const requiredAchievement = criteria.requiredAchievement || null;
  const parts = [];
  if (minLevel) parts.push(`Nv${minLevel}+ (${LEVEL_NAMES[minLevel] || ''})`.trim());
  if (requiredAchievement) {
    const a = achievements.getById(requiredAchievement);
    parts.push(`logro «${a ? a.name : requiredAchievement}»`);
  }
  return parts.length ? parts.join(' + ') : null;
}

module.exports = { walletMaxLevel, walletHasAchievement, checkEligibility, requirementLabel, LEVEL_NAMES };
