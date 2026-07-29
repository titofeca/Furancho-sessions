// ─────────────────────────────────────────────────────────────────────────────
//  BANCO DO CORCHO — SERVICIO ECONÓMICO $CORCHO
//  Maneja la lógica de recompensas, costes de peaje/traspaso de NFTs y tarifas.
// ─────────────────────────────────────────────────────────────────────────────

const {
  getSetting, setSetting,
  getCorchoBalance, getCorchoRanking, addCorchoCoins, spendCorchoCoins, getCorchoHistory, transferNftWithFee
} = require('../db/database');

const DEFAULT_RATES = {
  checkin: 100,            // Recompensa por fichar entrada en un Furancho
  exit: 25,               // Recompensa por fichar SALIDA (cerrar la noche)
  level1: 50,              // Recompensa por alcanzar Nivel 1 (Cautivo)
  level2: 100,             // Recompensa por alcanzar Nivel 2 (O Cunqueiro)
  level3: 250,             // Recompensa por alcanzar Nivel 3 (O Larpeiro)
  level4: 500,             // Recompensa por alcanzar Nivel 4 (O Presidente)
  referral: 75,            // Recompensa para ambos por Plan Amigo
  campaignVisit: 30,       // Recompensa por visita a la Terraza de verano
  campaignCompleted: 300,  // Recompensa por completar el Reto de los 5
  nftTransferFee: 150,     // Peaje en $CORCHO por traspasar un NFT entre wallets
  rsvpShowup: 15,          // Recompensa por cumplir RSVP ("Me apetece") y asistir
  vipShowup: 50,           // Recompensa por tener reserva VIP y asistir
  
  // Minijuegos
  enxebreEnabled: 1,       // 1 = activado, 0 = desactivado
  enxebreEntryCost: 0,     // Coste de jugar a O Enxebre
  enxebrePrize1: 50,
  enxebrePrize2: 40,
  enxebrePrize3: 30,
  enxebrePrize4: 20,
  enxebrePrize5: 10,
  enxebrePrize6: 5,
  cuncaEnabled: 1,         // 1 = activado, 0 = desactivado
  cuncaBasePot: 50,
  cuncaPassCost: 5,
  cuncaTimeoutMins: 60,

  // A Ruleta do Pulpo
  ruletaEnabled: 1,
  ruletaEntryCost: 10,
  ruletaSlice0: 0,          // Tentáculo seco (nada)
  ruletaSlice1: 0,          // Pimentón frío (nada)
  ruletaSlice2: 0,          // Cacheira seca (nada)
  ruletaSlice3: 0,          // Sal grosa (nada)
  ruletaSlice4: 5,          // Pimentón bueno (mitad)
  ruletaSlice5: 10,         // Aceite da casa (empate)
  ruletaSlice6: 20,         // Feira de Lugo (x2)
  ruletaSlice7: 40,         // Pulpo de Ouro (x4)
  ruletaMaxPlays: 3,        // Tiradas al día

  // A Queimada
  queimadaEnabled: 1,
  queimadaEntryCost: 15,
  queimadaMult21: 3,        // Multiplicador queimada perfecta (x3)
  queimadaMult1820: 2,      // Multiplicador 18-20 (x2)
  queimadaMult1517: 1,      // Multiplicador 15-17 (x1 = empate)
  queimadaMaxPlays: 3,       // Partidas al día
  // O Rasca Furancheiro
  rascaEnabled: 1,
  rascaEntryCost: 10,
  rascaPrize1: 100,        // Tres símbolos de oro
  rascaPrize2: 50,         // Tres símbolos de plata
  rascaPrize3: 20,         // Tres símbolos de bronce
  rascaMaxPlays: 3,

  // As Tragaperras da Ría
  tragaEnabled: 1,
  tragaEntryCost: 10,
  tragaPrize3: 100,        // 3 símbolos iguales
  tragaPrize2: 10,         // 2 símbolos iguales
  tragaMaxPlays: 5,

  // A Chave Virtual
  chaveEnabled: 1,
  chaveEntryCost: 10,
  chavePrizePleno: 50,
  chavePrizeRoce: 15,
  chaveMaxPlays: 3,

  // Trivial Furancheiro
  trivialEnabled: 1,
  trivialEntryCost: 5,
  trivialPrize: 100,
  trivialMaxPlays: 1,      // Solo 1 intento diario para acertar las 3 preguntas
  
  // Modo Vacaciones
  vacationMode: 0,
  vacationMaxDailyGameCorchos: 2
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
    exit: getRate('exit'),
    level1: getRate('level1'),
    level2: getRate('level2'),
    level3: getRate('level3'),
    level4: getRate('level4'),
    referral: getRate('referral'),
    campaignVisit: getRate('campaignVisit'),
    campaignCompleted: getRate('campaignCompleted'),
    nftTransferFee: getRate('nftTransferFee'),
    rsvpShowup: getRate('rsvpShowup'),
    vipShowup: getRate('vipShowup'),
    enxebreEnabled: getRate('enxebreEnabled'),
    enxebreEntryCost: getRate('enxebreEntryCost'),
    enxebrePrize1: getRate('enxebrePrize1'),
    enxebrePrize2: getRate('enxebrePrize2'),
    enxebrePrize3: getRate('enxebrePrize3'),
    enxebrePrize4: getRate('enxebrePrize4'),
    enxebrePrize5: getRate('enxebrePrize5'),
    enxebrePrize6: getRate('enxebrePrize6'),
    cuncaEnabled: getRate('cuncaEnabled'),
    cuncaBasePot: getRate('cuncaBasePot'),
    cuncaPassCost: getRate('cuncaPassCost'),
    cuncaTimeoutMins: getRate('cuncaTimeoutMins'),
    ruletaEnabled: getRate('ruletaEnabled'),
    ruletaEntryCost: getRate('ruletaEntryCost'),
    ruletaSlice0: getRate('ruletaSlice0'),
    ruletaSlice1: getRate('ruletaSlice1'),
    ruletaSlice2: getRate('ruletaSlice2'),
    ruletaSlice3: getRate('ruletaSlice3'),
    ruletaSlice4: getRate('ruletaSlice4'),
    ruletaSlice5: getRate('ruletaSlice5'),
    ruletaSlice6: getRate('ruletaSlice6'),
    ruletaSlice7: getRate('ruletaSlice7'),
    ruletaMaxPlays: getRate('ruletaMaxPlays'),
    queimadaEnabled: getRate('queimadaEnabled'),
    queimadaEntryCost: getRate('queimadaEntryCost'),
    queimadaMult21: getRate('queimadaMult21'),
    queimadaMult1820: getRate('queimadaMult1820'),
    queimadaMult1517: getRate('queimadaMult1517'),
    queimadaMaxPlays: getRate('queimadaMaxPlays'),
    vacationMode: getRate('vacationMode'),
    vacationMaxDailyGameCorchos: getRate('vacationMaxDailyGameCorchos')
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

// Recompensa por fichar SALIDA. Idempotente por sesión: cada salida cerrada da una
// sola vez su recompensa (refId = id de la sesión), tanto en vivo como en el backfill.
function rewardExit(walletAddress, sessionId) {
  const amount = getRate('exit');
  if (!amount || amount <= 0) return { added: false };
  return addCorchoCoins(
    walletAddress,
    amount,
    'exit',
    `🚪 Fichaje de salida (+${amount} $CORCHO)`,
    `exit_session_${sessionId}`
  );
}

// Recompensa por cumplir RSVP ("Me apetece") y asistir
function rewardRsvpShowup(walletAddress, eventId) {
  const amount = getRate('rsvpShowup');
  if (!amount || amount <= 0) return { added: false };
  return addCorchoCoins(
    walletAddress,
    amount,
    'rsvp_showup',
    `📅 Fichaje tras avisar "Me apetece" (+${amount} $CORCHO)`,
    `rsvp_showup_${eventId}`
  );
}

// Recompensa por tener reserva VIP y asistir
function rewardVipShowup(walletAddress, eventId) {
  const amount = getRate('vipShowup');
  if (!amount || amount <= 0) return { added: false };
  return addCorchoCoins(
    walletAddress,
    amount,
    'vip_showup',
    `⭐ Fichaje con Reserva VIP (+${amount} $CORCHO)`,
    `vip_showup_${eventId}`
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

// Recompensa por visita de campaña. La refId se normaliza SIEMPRE a `camp_<fecha>`
// (aquí dentro), para que el registro EN VIVO y el backfill produzcan la misma clave
// y no se acredite dos veces la misma visita. Acepta que le pasen la fecha ya con
// prefijo (idempotente) o sin él.
function rewardCampaignVisit(walletAddress, visitDate) {
  const amount = getRate('campaignVisit');
  const key = String(visitDate || '').startsWith('camp_') ? visitDate : `camp_${visitDate}`;
  return addCorchoCoins(
    walletAddress,
    amount,
    'campaign_visit',
    `☀️ Visita Terraza de Verano (+${amount} $CORCHO)`,
    key
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

  // Campaña Colega VIP (Marketing Growth)
  try {
    const { db, getAppSetting } = require('../db/database');
    if (getAppSetting('promo_referral_vip') === '1') {
      const raffleId = parseInt(getAppSetting('promo_referral_vip_raffle_id'), 10);
      if (raffleId > 0) {
        const stmt = db.prepare(`
          INSERT INTO raffle_participants (raffle_id, wallet_address, is_vip, status)
          VALUES (?, ?, 0, 'active')
          ON CONFLICT(raffle_id, wallet_address) DO NOTHING
        `);
        stmt.run(raffleId, referrerWallet);
        stmt.run(raffleId, newWallet);
      }
    }
  } catch(e) {
    console.error('Error adding to VIP referral raffle:', e);
  }
}

// Sincronización retroactiva idempotente de CorchoCoins para clientes existentes
function syncRetroactiveCorchoCoins() {
  try {
    const { db } = require('../db/database');

    // 1. Mints de Nivel
    const mints = db.prepare(`SELECT wallet_address, level FROM mints WHERE status = 'success'`).all();
    for (const m of mints) {
      if (!m.wallet_address) continue;
      rewardLevelAward(m.wallet_address, m.level);
    }

    // 2. Sesiones de eventos pasadas
    const sessions = db.prepare(`SELECT wallet_address, entry_time FROM sessions WHERE counted_as_visit = 1`).all();
    for (const s of sessions) {
      if (!s.wallet_address) continue;
      const dateStr = s.entry_time ? s.entry_time.slice(0, 10) : 'past_session';
      rewardCheckin(s.wallet_address, `event_${dateStr}`);
    }

    // 2b. Salidas ya registradas. Solo las sesiones que CONTARON como visita
    // (counted_as_visit = 1): así el premio de salida va 1:1 con las visitas reales
    // y no se puede farmear con re-entradas (que abren sesiones sin contar). Cubre
    // salidas cerradas por el cliente, el staff o el auto-cierre. Idempotente por sesión.
    const exits = db.prepare(`SELECT id, wallet_address FROM sessions WHERE exit_time IS NOT NULL AND counted_as_visit = 1`).all();
    for (const s of exits) {
      if (!s.wallet_address) continue;
      rewardExit(s.wallet_address, s.id);
    }

    // 3. Visitas pasadas
    const visits = db.prepare(`SELECT wallet_address, event_date, visited_at FROM visits`).all();
    for (const v of visits) {
      if (!v.wallet_address) continue;
      const dateStr = v.event_date || (v.visited_at ? v.visited_at.slice(0, 10) : 'past_visit');
      rewardCheckin(v.wallet_address, `event_${dateStr}`);
    }

    // 4. Campaña de verano pasadas
    const campVisits = db.prepare(`SELECT wallet_address, visit_date FROM campaign_visits`).all();
    for (const c of campVisits) {
      if (!c.wallet_address) continue;
      rewardCampaignVisit(c.wallet_address, `camp_${c.visit_date}`);
    }
  } catch (e) {
    console.error('Error en sincronización retroactiva de CorchoCoins:', e.message);
  }
}

// Ejecutar sincronización retroactiva al inicializar
setTimeout(syncRetroactiveCorchoCoins, 1000);

module.exports = {
  DEFAULT_RATES,
  getRate,
  getEconomySettings,
  saveEconomySettings,
  rewardCheckin,
  rewardExit,
  rewardRsvpShowup,
  rewardVipShowup,
  rewardLevelAward,
  rewardCampaignVisit,
  rewardReferral,
  syncRetroactiveCorchoCoins,
  getCorchoBalance,
  getCorchoRanking,
  addCorchoCoins,
  spendCorchoCoins,
  getCorchoHistory,
  transferNftWithFee
};

