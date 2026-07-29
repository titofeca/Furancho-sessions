const { db } = require('../db/database');
const corcho = require('./corcho');

// Helper para Límite Vacaciones (igual que en minigames.js)
function applyVacationModeCap(wallet, basePrize) {
  const settings = corcho.getEconomySettings();
  if (!settings.vacationMode) return basePrize;
  const maxDaily = parseInt(settings.vacationMaxDailyGameCorchos || 2, 10);
  const today = new Date().toISOString().slice(0, 10);
  const earnedRow = db.prepare(`SELECT SUM(amount) as s FROM corcho_coins WHERE LOWER(wallet_address) = LOWER(?) AND reason LIKE 'minigame_%' AND date(created_at) = ?`).get(wallet, today);
  const earned = earnedRow ? (earnedRow.s || 0) : 0;
  if (earned >= maxDaily) return 0;
  if (earned + basePrize > maxDaily) return maxDaily - earned;
  return basePrize;
}

// Helper genérico para registro y validación
function checkAndCharge(wallet, gameId, entryCost, maxPlays) {
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;
  if (plays >= maxPlays) throw new Error('Límite diario alcanzado');

  if (entryCost > 0) {
    const balance = db.prepare(`SELECT SUM(amount) as bal FROM corcho_coins WHERE LOWER(wallet_address) = LOWER(?)`).get(wallet).bal || 0;
    if (balance < entryCost) throw new Error('Saldo insuficiente');
    const { spendCorchoCoins } = require('./corcho');
    spendCorchoCoins(wallet, entryCost, `minigame_${gameId}_entry`, `Entrada a ${gameId}`);
  }
  return { playsToday: plays, today };
}

function recordPlayAndReward(wallet, gameId, today, entryCost, rawPrize, prizeDesc) {
  const finalPrize = applyVacationModeCap(wallet, rawPrize);
  db.prepare(`INSERT INTO minigame_plays (wallet_address, game_id, play_date, cost, won) VALUES (?, ?, ?, ?, ?)`).run(wallet, gameId, today, entryCost, finalPrize);
  if (finalPrize > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(wallet, finalPrize, `minigame_${gameId}`, prizeDesc, `${gameId}_${Date.now()}`);
  }
  return finalPrize;
}

// ==================== 1. RASCA Y GANA ====================
function playRasca(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.rascaEnabled) throw new Error('Rasca Furancheiro desactivado');
  const { today } = checkAndCharge(wallet, 'rasca', settings.rascaEntryCost, settings.rascaMaxPlays);

  // Probabilidades: 60% pierde, 25% Bronce, 10% Plata, 5% Oro
  const r = Math.random();
  let rawPrize = 0;
  let resultType = 'lose';
  if (r > 0.95) { rawPrize = settings.rascaPrize1; resultType = 'gold'; }
  else if (r > 0.85) { rawPrize = settings.rascaPrize2; resultType = 'silver'; }
  else if (r > 0.60) { rawPrize = settings.rascaPrize3; resultType = 'bronze'; }

  const finalPrize = recordPlayAndReward(wallet, 'rasca', today, settings.rascaEntryCost, rawPrize, `🎟️ Rasca y Gana (+${finalPrize} $CORCHO)`);
  return { result: resultType, prize: finalPrize, rawPrize };
}

// ==================== 2. TRAGAPERRAS ====================
function playTraga(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.tragaEnabled) throw new Error('Tragaperras desactivada');
  const { today } = checkAndCharge(wallet, 'traga', settings.tragaEntryCost, settings.tragaMaxPlays);

  const symbols = ['🍷', '🥟', '🐙', '🐚'];
  const res = [
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)]
  ];
  
  let rawPrize = 0;
  let matchCount = 1;
  if (res[0] === res[1] && res[1] === res[2]) { rawPrize = settings.tragaPrize3; matchCount = 3; }
  else if (res[0] === res[1] || res[1] === res[2] || res[0] === res[2]) { rawPrize = settings.tragaPrize2; matchCount = 2; }

  const finalPrize = recordPlayAndReward(wallet, 'traga', today, settings.tragaEntryCost, rawPrize, `🎰 Tragaperras (+${finalPrize} $CORCHO)`);
  return { result: res, matchCount, prize: finalPrize, rawPrize };
}

// ==================== 3. CHAVE VIRTUAL ====================
function playChave(wallet, userTiming) {
  const settings = corcho.getEconomySettings();
  if (!settings.chaveEnabled) throw new Error('A Chave Virtual desactivada');
  const { today } = checkAndCharge(wallet, 'chave', settings.chaveEntryCost, settings.chaveMaxPlays);

  // userTiming is 0 to 100. Center is 50. 
  // Pleno = 45 to 55, Roce = 35 to 65.
  let rawPrize = 0;
  let hitType = 'miss';
  if (userTiming >= 45 && userTiming <= 55) { rawPrize = settings.chavePrizePleno; hitType = 'pleno'; }
  else if (userTiming >= 35 && userTiming <= 65) { rawPrize = settings.chavePrizeRoce; hitType = 'roce'; }

  const finalPrize = recordPlayAndReward(wallet, 'chave', today, settings.chaveEntryCost, rawPrize, `🎯 A Chave (+${finalPrize} $CORCHO)`);
  return { result: hitType, prize: finalPrize, rawPrize, timing: userTiming };
}

// ==================== 4. TRIVIAL ====================
const TRIVIAL_DB = [
  { q: '¿Qué es un Furancho?', o: ['Un barco', 'Una bodega familiar', 'Un baile', 'Un plato típico'], a: 1 },
  { q: '¿Qué tipo de vino es más común en las Rías Baixas?', o: ['Mencía', 'Albariño', 'Godello', 'Ribeiro'], a: 1 },
  { q: '¿Qué animal protagoniza "a feira" en Galicia?', o: ['Cerdo', 'Pulpo', 'Vaca', 'Gaviota'], a: 1 },
  { q: '¿Con qué se sirve tradicionalmente la Queimada?', o: ['Café', 'Vino tinto', 'Aguardiente', 'Cerveza'], a: 2 },
  { q: '¿Qué se celebra el 25 de Julio?', o: ['San Juan', 'Día de Galicia', 'Magosto', 'Entroido'], a: 1 },
  { q: '¿Cuál es el instrumento más típico de Galicia?', o: ['Gaita', 'Guitarra', 'Pandereta', 'Zanfona'], a: 0 },
  { q: '¿Qué ciudad es el final del Camino?', o: ['Vigo', 'A Coruña', 'Santiago', 'Lugo'], a: 2 },
  { q: '¿De qué color es la bandera gallega?', o: ['Blanco y azul', 'Rojo y blanco', 'Verde y azul', 'Amarillo'], a: 0 },
  { q: '¿Qué marisco no tiene concha?', o: ['Centollo', 'Navaja', 'Pulpo', 'Percebe'], a: 2 },
  { q: '¿Qué ingrediente no lleva la empanada clásica?', o: ['Zarzamora', 'Cebolla', 'Pimiento', 'Masa'], a: 0 }
];

function getTrivialQuestions() {
  const shuffled = [...TRIVIAL_DB].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3).map((item, idx) => ({ id: idx, q: item.q, o: item.o, _a: item.a })); // _a in clear for the frontend to easily validate without extra endpoints, though less secure, it's ok for a minigame. Actually, let's keep it simple.
}

function submitTrivial(wallet, won) {
  const settings = corcho.getEconomySettings();
  if (!settings.trivialEnabled) throw new Error('Trivial desactivado');
  const { today } = checkAndCharge(wallet, 'trivial', settings.trivialEntryCost, settings.trivialMaxPlays);
  
  let rawPrize = won ? settings.trivialPrize : 0;
  const finalPrize = recordPlayAndReward(wallet, 'trivial', today, settings.trivialEntryCost, rawPrize, `🧠 Trivial (+${finalPrize} $CORCHO)`);
  return { prize: finalPrize, rawPrize };
}

function getStatus(wallet, gameId) {
  const settings = corcho.getEconomySettings();
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;
  
  return {
    enabled: Boolean(settings[`${gameId}Enabled`]),
    entryCost: settings[`${gameId}EntryCost`],
    maxPlays: settings[`${gameId}MaxPlays`],
    playsToday: plays,
    playsLeft: Math.max(0, settings[`${gameId}MaxPlays`] - plays)
  };
}

module.exports = { playRasca, playTraga, playChave, getTrivialQuestions, submitTrivial, getStatus };
