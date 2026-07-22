// ─────────────────────────────────────────────────────────────────────────────
//  BANCO DO CORCHO — SERVICIO ECONÓMICO $CORCHO
//  Maneja la lógica de recompensas, costes de peaje/traspaso de NFTs y tarifas.
// ─────────────────────────────────────────────────────────────────────────────

const {
  getSetting, setSetting,
  getCorchoBalance, addCorchoCoins, spendCorchoCoins, getCorchoHistory, transferNftWithFee
} = require('../db/database');

const DEFAULT_RATES = {
  checkin: 100,            // Recompensa por fichar entrada en un Furancho
  level1: 50,              // Recompensa por alcanzar Nivel 1 (Cautivo)
  level2: 100,             // Recompensa por alcanzar Nivel 2 (O Cunqueiro)
  level3: 250,             // Recompensa por alcanzar Nivel 3 (O Larpeiro)
  level4: 500,             // Recompensa por alcanzar Nivel 4 (O Presidente)
  referral: 75,            // Recompensa para ambos por Plan Amigo
  campaignVisit: 30,       // Recompensa por visita a la Terraza de verano
  campaignCompleted: 300,  // Recompensa por completar el Reto de los 5
  nftTransferFee: 150      // Peaje en $CORCHO por traspasar un NFT entre wallets
};

function getRate(key) {
  const val = getSetting(`corcho_rate_${key}`, null);
  if (val !== null && val !== undefined && !isNaN(parseInt(val, 10))) {
    return parseInt(val, 10);
  }
  return DEFAULT_RATES[key] !== undefined ? DEFAULT_RATES[key] : 100;
}

function getEconomySettings() {
  return {
    checkin: getRate('checkin'),
    level1: getRate('level1'),
    level2: getRate('level2'),
    level3: getRate('level3'),
    level4: getRate('level4'),
    referral: getRate('referral'),
    campaignVisit: getRate('campaignVisit'),
    campaignCompleted: getRate('campaignCompleted'),
    nftTransferFee: getRate('nftTransferFee')
  };
}

function saveEconomySettings(rates = {}) {
  for (const [key, val] of Object.entries(rates)) {
    if (DEFAULT_RATES[key] !== undefined && !isNaN(parseInt(val, 10))) {
      setSetting(`corcho_rate_${key}`, String(Math.max(0, parseInt(val, 10))));
    }
  }
  return getEconomySettings();
}

// Recompensa por fichaje de entrada
function rewardCheckin(walletAddress, eventIdOrDate) {
  const amount = getRate('checkin');
  return addCorchoCoins(
    walletAddress,
    amount,
    'checkin',
    `🍷 Fichaje no Furancho (+${amount} $CORCHO)`,
    eventIdOrDate || 'checkin_event'
  );
}

// Recompensa por nivel alcanzado
function rewardLevelAward(walletAddress, level) {
  const rateKey = `level${level}`;
  const amount = getRate(rateKey);
  if (!amount || amount <= 0) return { added: false };
  return addCorchoCoins(
    walletAddress,
    amount,
    'level_award',
    `🏆 Subida a Nivel ${level} (+${amount} $CORCHO)`,
    `level_${level}`
  );
}

// Recompensa por visita de campaña
function rewardCampaignVisit(walletAddress, visitDate) {
  const amount = getRate('campaignVisit');
  return addCorchoCoins(
    walletAddress,
    amount,
    'campaign_visit',
    `☀️ Visita Terraza de Verano (+${amount} $CORCHO)`,
    visitDate
  );
}

// Recompensa por referir amigo
function rewardReferral(referrerWallet, newWallet) {
  const amount = getRate('referral');
  // Recompensa al padrino
  addCorchoCoins(
    referrerWallet,
    amount,
    'referral',
    `🤝 Plan Amigo: nuevo socio referido (+${amount} $CORCHO)`,
    `ref_${newWallet.toLowerCase()}`
  );
  // Recompensa al nuevo socio
  addCorchoCoins(
    newWallet,
    amount,
    'referral',
    `🤝 Bienvenida Plan Amigo (+${amount} $CORCHO)`,
    `ref_welcome_${referrerWallet.toLowerCase()}`
  );
}

module.exports = {
  DEFAULT_RATES,
  getRate,
  getEconomySettings,
  saveEconomySettings,
  rewardCheckin,
  rewardLevelAward,
  rewardCampaignVisit,
  rewardReferral,
  getCorchoBalance,
  addCorchoCoins,
  spendCorchoCoins,
  getCorchoHistory,
  transferNftWithFee
};
