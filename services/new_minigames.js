const { db } = require('../db/database');
const corcho = require('./corcho');

function getMadridDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

function applyVacationModeCap(wallet, basePrize) {
  const settings = corcho.getEconomySettings();
  if (!settings.vacationMode) return basePrize;
  const maxDaily = parseInt(settings.vacationMaxDailyGameCorchos || 2, 10);
  const today = getMadridDateStr();
  const earnedRow = db.prepare(`
    SELECT SUM(amount) as s FROM corcho_transactions
    WHERE LOWER(wallet_address) = LOWER(?)
      AND type LIKE 'minigame_%'
      AND amount > 0
      AND date(created_at, 'localtime') >= date(?)
  `).get(wallet, today);
  const earned = earnedRow ? (earnedRow.s || 0) : 0;
  if (earned >= maxDaily) return 0;
  if (earned + basePrize > maxDaily) return maxDaily - earned;
  return basePrize;
}

// Cobro real y atómico: antes getCorchoBalance devolvía objeto {balance} y
// (obj < cost) daba false, permitiendo jugar gratis con saldo 0.
function checkAndCharge(wallet, gameId, entryCost, maxPlays) {
  const settings = corcho.getEconomySettings();
  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;

  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (maxPlays || 1);
  if (plays >= effectiveMaxPlays) {
    throw new Error(vacation ? '🏖️ Modo Vacaciones: Solo se puede jugar hasta 3 veces al día a cada juego' : 'Límite diario alcanzado');
  }

  const effectiveCost = vacation ? 0 : (entryCost || 0);
  if (effectiveCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, effectiveCost, `minigame_${gameId}_entry`, `🕹️ Entrada a ${gameId} (-${effectiveCost} $CORCHO)`);
    if (!res.ok) {
      throw new Error(`Saldo insuficiente. Necesitas ${effectiveCost} $CORCHO (tienes ${res.currentBalance || 0} $CORCHO)`);
    }
  }
  return { playsToday: plays, today, effectiveCost, effectiveMaxPlays };
}

function recordPlayAndReward(wallet, gameId, today, entryCost, rawPrize, prizeDesc) {
  const finalPrize = applyVacationModeCap(wallet, rawPrize);
  db.prepare(`INSERT INTO minigame_plays (wallet_address, game_id, play_date, cost, won) VALUES (?, ?, ?, ?, ?)`).run(wallet, gameId, today, entryCost, finalPrize);
  if (finalPrize > 0) {
    const { addCorchoCoins } = require('./corcho');
    const desc = prizeDesc ? `${prizeDesc} (+${finalPrize} $CORCHO)` : `Premio ${gameId} (+${finalPrize} $CORCHO)`;
    addCorchoCoins(wallet, finalPrize, `minigame_${gameId}`, desc, `${gameId}_${Date.now()}`);
  }
  try {
    corcho.grantReopeningTicket(wallet, `minigame_${gameId}`);
  } catch (_) {}
  return finalPrize;
}

// ==================== 1. RASCA DE CORCHO E LACRE ====================
function playRasca(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.rascaEnabled) throw new Error('Rasca Furancheiro desactivado');
  const { today, effectiveCost, playsToday, effectiveMaxPlays } = checkAndCharge(wallet, 'rasca', settings.rascaEntryCost, settings.rascaMaxPlays);

  const r = Math.random();
  let rawPrize = 0;
  let resultType = 'lose';
  let symbols = ['🏺', '🌿', '🐚'];
  if (r > 0.95) {
    rawPrize = settings.rascaPrize1;
    resultType = 'gold';
    symbols = ['👑', '👑', '👑'];
  } else if (r > 0.85) {
    rawPrize = settings.rascaPrize2;
    resultType = 'silver';
    symbols = ['🍷', '🍷', '🍷'];
  } else if (r > 0.60) {
    rawPrize = settings.rascaPrize3;
    resultType = 'bronze';
    symbols = ['🐙', '🐙', '🐙'];
  } else {
    const pool = ['🍷', '🐙', '🌿', '🐚', '🥟'];
    const a = pool[Math.floor(Math.random() * pool.length)];
    let b = pool[(pool.indexOf(a) + 1 + Math.floor(Math.random() * 3)) % pool.length];
    let c = pool[(pool.indexOf(b) + 1) % pool.length];
    symbols = [a, b, c];
  }

  const finalPrize = recordPlayAndReward(wallet, 'rasca', today, effectiveCost, rawPrize, '🎟️ Rasca do Furancho');
  return { result: resultType, symbols, prize: finalPrize, rawPrize, playsLeft: Math.max(0, effectiveMaxPlays - playsToday - 1) };
}

// ==================== 2. TRAGAPERRAS DA RÍA '85 ====================
function playTraga(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.tragaEnabled) throw new Error('Tragaperras desactivada');
  const { today, effectiveCost, playsToday, effectiveMaxPlays } = checkAndCharge(wallet, 'traga', settings.tragaEntryCost, settings.tragaMaxPlays);

  const symbols = ['🍷', '🥟', '🐙', '🐚', '🌿'];
  const res = [
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)]
  ];

  let rawPrize = 0;
  let matchCount = 1;
  if (res[0] === res[1] && res[1] === res[2]) { rawPrize = settings.tragaPrize3; matchCount = 3; }
  else if (res[0] === res[1] || res[1] === res[2] || res[0] === res[2]) { rawPrize = settings.tragaPrize2; matchCount = 2; }

  const finalPrize = recordPlayAndReward(wallet, 'traga', today, effectiveCost, rawPrize, '🎰 Recreativa A Ría \'85');
  return { result: res, matchCount, prize: finalPrize, rawPrize, playsLeft: Math.max(0, effectiveMaxPlays - playsToday - 1) };
}

// ==================== 3. A CHAVE NO TERREIRO ====================
function playChave(wallet, userTiming, lateralError = 0) {
  const settings = corcho.getEconomySettings();
  if (!settings.chaveEnabled) throw new Error('A Chave Virtual desactivada');
  const { today, effectiveCost, playsToday, effectiveMaxPlays } = checkAndCharge(wallet, 'chave', settings.chaveEntryCost, settings.chaveMaxPlays);

  const t = Number(userTiming) || 0;
  const lat = Math.abs(Number(lateralError) || 0); // 0 = centro exacto
  let rawPrize = 0;
  let hitType = 'miss';
  if (t >= 44 && t <= 56 && lat <= 18) { rawPrize = settings.chavePrizePleno; hitType = 'pleno'; }
  else if (t >= 34 && t <= 66 && lat <= 34) { rawPrize = settings.chavePrizeRoce; hitType = 'roce'; }

  const finalPrize = recordPlayAndReward(wallet, 'chave', today, effectiveCost, rawPrize, '🎯 A Chave no Terreiro');
  return { result: hitType, prize: finalPrize, rawPrize, timing: t, playsLeft: Math.max(0, effectiveMaxPlays - playsToday - 1) };
}

// ==================== 4. TRIVIAL DA PARROQUIA (100% SERVER VALIDATED) ====================
const TRIVIAL_DB = [
  { q: '¿Qué es tradicionalmente un Furancho en Galicia?', o: ['Un barco pesquero', 'Un bajo familiar que vende el excedente de su vino de casa', 'Un baile de romería', 'Un postre de Entroido'], a: 1 },
  { q: '¿Qué se cuelga en la puerta para anunciar que el furancho está abierto y hay vino?', o: ['Una bandera roja', 'Una rama fresca de laurel (loureiro)', 'Una teja pintada', 'Un farol azul'], a: 1 },
  { q: '¿Cómo se llaman las tazas blancas de loza o barro donde se bebe el vino do país?', o: ['Cuncas', 'Copas de balón', 'Porrones', 'Cañeros'], a: 0 },
  { q: '¿Qué uva blanca es emblema de las Rías Baixas?', o: ['Mencía', 'Albariño', 'Garnacha', 'Palomino'], a: 1 },
  { q: '¿Qué tapa furancheira es picadillo o lomo de cerdo adobado con pimentón y ajo?', o: ['Caldeirada', 'Zorza', 'Filloa', 'Bica'], a: 1 },
  { q: '¿Qué uva tinta predomina en los bancales heroicos de la Ribeira Sacra?', o: ['Mencía', 'Verdejo', 'Airén', 'Syrah'], a: 0 },
  { q: '¿Dónde se quema el aguardiente con azúcar, limón y granos de café?', o: ['En un pote o cazuela de barro de queimada', 'En jarra de cristal', 'En bota de cuero', 'En barrica cerrada'], a: 0 },
  { q: '¿Qué condimento nunca falta sobre el pulpo á feira además de aceite y sal gruesa?', o: ['Orégano', 'Pimentón dulce y picante', 'Comino', 'Nuez moscada'], a: 1 },
  { q: '¿De qué parroquia son célebres los pimientos "uns pican e outros non"?', o: ['Herbón (Padrón)', 'Combarro', 'Guitiriz', 'Verín'], a: 0 },
  { q: '¿Cómo se llama el pan tradicional gallego elaborado con harina de maíz?', o: ['Broa (pan de millo)', 'Fougasse', 'Chapata', 'Mollete'], a: 0 },
  { q: '¿En qué villa pontevedresa se celebra en agosto la histórica Festa do Albariño?', o: ['Tui', 'Cambados', 'Lalín', 'Viveiro'], a: 1 },
  { q: '¿Qué pescadito pequeño frito o guisado es tapa mítica de tasca en la costa gallega?', o: ['Xoubiñas (parrochas)', 'Trucha asalmonada', 'Pez espada', 'Rodaballo'], a: 0 },
  { q: '¿Qué cabo gallego llamaban los romanos "Finis Terrae"?', o: ['Cabo Prior', 'Cabo Fisterra', 'Cabo Silleiro', 'Punta Herminia'], a: 1 },
  { q: '¿Qué lleva el auténtico caldo galego junto a patatas, habas y unto?', o: ['Grelos o nabizas', 'Lechuga iceberg', 'Espárragos trigueros', 'Berenjena'], a: 0 },
  { q: '¿Qué tarta tradicional de almendra lleva espolvoreada la Cruz de Santiago?', o: ['Bica de Trives', 'Tarta de Santiago', 'Larpeira', 'Tarta de Mondoñedo'], a: 1 },
  { q: '¿Qué fruto asado en tambor sobre brasas protagoniza el Magosto de otoño?', o: ['Bellota', 'Castaña', 'Piñón', 'Avellana'], a: 1 },
  { q: '¿Qué faro romano en A Coruña sigue en activo desde hace casi dos mil años?', o: ['Faro de Budiño', 'Torre de Hércules', 'Faro de Lariño', 'Faro de Bares'], a: 1 },
  { q: '¿Cómo se llama la construcción elevada sobre pegollos para secar y guardar el maíz?', o: ['Hórreo (canastro)', 'Palloza', 'Cruceiro', 'Alpendre'], a: 0 },
  { q: '¿En qué juego tradicional gallego se lanzan pellotes de hierro a un aspa metálica?', o: ['Billarda', 'A Chave', 'Rana', 'Tuta'], a: 1 },
  { q: '¿Cómo se llama el recipiente grande de madera con aros de hierro donde reposa el vino?', o: ['Pipote o cuba', 'Alambique', 'Cántara', 'Queixeira'], a: 0 },
  { q: '¿Qué licor oscuro casero es imprescindible en la sobremesa gallega?', o: ['Anís seco', 'Licor café', 'Pacharán', 'Limoncello'], a: 1 },
  { q: '¿Qué villa marinera es famosa por sus hórreos de piedra asomados directamente a la ría?', o: ['Ribadeo', 'Combarro', 'Monforte', 'Allariz'], a: 1 },
  { q: '¿Qué tapa clásica de cerdo cocido se sirve cortada con pimentón y aceite de oliva?', o: ['Orella á galega', 'Carpaccio', 'Morcilla de arroz', 'Torrezno'], a: 0 },
  { q: '¿Qué embutido tradicional gallego se elabora con costilla de cerdo adobada y ahumada?', o: ['Salchichón', 'Androlla / Botelo', 'Fuet', 'Sobrasada'], a: 1 },
  { q: '¿Qué postre fino hecho en sartén o pedra con caldo o leche es rey del Entroido?', o: ['Filloas', 'Churros', 'Torrijas', 'Pestiños'], a: 0 }
];

const _activeTrivials = new Map();

function buildTrivialSetForWallet(walletAddress) {
  const todayStr = getMadridDateStr();
  const wLower = String(walletAddress || '').toLowerCase();
  let hash = 2166136261;
  const seedStr = `${wLower}:${todayStr}`;
  for (let i = 0; i < seedStr.length; i++) {
    hash ^= seedStr.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const absSeed = Math.abs(hash);
  const total = TRIVIAL_DB.length;
  const used = new Set();
  const questions = [];

  let step = 0;
  while (questions.length < 3 && step < 50) {
    const idx = (absSeed + step * 7 + step * step * 3) % total;
    step++;
    if (used.has(idx)) continue;
    used.add(idx);
    const item = TRIVIAL_DB[idx];
    // Barajar opciones de forma determinista para que la respuesta correcta cambie de posición
    const indices = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = (absSeed + idx * 13 + i * 19) % (i + 1);
      const tmp = indices[i];
      indices[i] = indices[j];
      indices[j] = tmp;
    }
    const shuffledOptions = indices.map(k => item.o[k]);
    const correctShuffledIdx = indices.indexOf(item.a);
    questions.push({
      id: idx,
      q: item.q,
      o: shuffledOptions,
      _correct: correctShuffledIdx
    });
  }
  return questions;
}

// Público: NUNCA envía la respuesta correcta al navegador
function getTrivialQuestions(walletAddress) {
  return buildTrivialSetForWallet(walletAddress).map(({ id, q, o }) => ({ id, q, o }));
}

function startTrivialSession(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.trivialEnabled) throw new Error('Trivial desactivado');
  const wKey = wallet.toLowerCase();
  if (_activeTrivials.has(wKey)) {
    return { started: true, resumed: true, questions: getTrivialQuestions(wallet) };
  }
  const { today, effectiveCost } = checkAndCharge(wallet, 'trivial', settings.trivialEntryCost, settings.trivialMaxPlays);
  // Registrar la partida al empezar para impedir recargar la página si fallas la 1ª pregunta
  db.prepare(`INSERT INTO minigame_plays (wallet_address, game_id, play_date, cost, won) VALUES (?, 'trivial', ?, ?, 0)`).run(wallet, today, effectiveCost);
  const playRow = db.prepare(`SELECT last_insert_rowid() as id`).get();
  _activeTrivials.set(wKey, { playRowId: playRow?.id, today, effectiveCost, startedAt: Date.now() });
  return { started: true, questions: getTrivialQuestions(wallet), entryCost: effectiveCost };
}

function checkTrivialSingleAnswer(wallet, questionIndex, selectedIdx) {
  const fullSet = buildTrivialSetForWallet(wallet);
  const q = fullSet[questionIndex];
  if (!q) throw new Error('Pregunta no válida');
  return { correct: Number(selectedIdx) === q._correct, correctIndex: q._correct };
}

function submitTrivial(wallet, userParam) {
  const settings = corcho.getEconomySettings();
  if (!settings.trivialEnabled) throw new Error('Trivial desactivado');
  const wKey = wallet.toLowerCase();
  const sess = _activeTrivials.get(wKey);

  // Si no pasó por /start (compatibilidad), cobrar y registrar ahora
  let today = getMadridDateStr();
  let playRowId = null;
  if (sess) {
    today = sess.today;
    playRowId = sess.playRowId;
    _activeTrivials.delete(wKey);
  } else {
    const charged = checkAndCharge(wallet, 'trivial', settings.trivialEntryCost, settings.trivialMaxPlays);
    today = charged.today;
    db.prepare(`INSERT INTO minigame_plays (wallet_address, game_id, play_date, cost, won) VALUES (?, 'trivial', ?, ?, 0)`).run(wallet, today, charged.effectiveCost);
    playRowId = db.prepare(`SELECT last_insert_rowid() as id`).get()?.id;
  }

  const fullSet = buildTrivialSetForWallet(wallet);
  let answers = null;
  if (Array.isArray(userParam)) answers = userParam;
  else if (userParam && Array.isArray(userParam.answers)) answers = userParam.answers;

  const won = Array.isArray(answers)
    && answers.length === fullSet.length
    && fullSet.every((q, idx) => Number(answers[idx]) === q._correct);

  const rawPrize = won ? (settings.trivialPrize || 0) : 0;
  const finalPrize = applyVacationModeCap(wallet, rawPrize);

  if (playRowId && finalPrize > 0) {
    db.prepare(`UPDATE minigame_plays SET won = ? WHERE id = ?`).run(finalPrize, playRowId);
  }
  if (finalPrize > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(wallet, finalPrize, 'minigame_trivial', `📻 Trivial da Parroquia (+${finalPrize} $CORCHO)`, `trivial_${Date.now()}`);
  }
  try { corcho.grantReopeningTicket(wallet, 'minigame_trivial'); } catch (_) {}

  return { prize: finalPrize, rawPrize, won };
}

function getStatus(wallet, gameId) {
  const settings = corcho.getEconomySettings();
  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;

  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings[`${gameId}MaxPlays`] || 1);
  const effectiveCost = vacation ? 0 : (settings[`${gameId}EntryCost`] || 0);
  const hasActiveTrivial = gameId === 'trivial' && _activeTrivials.has(String(wallet || '').toLowerCase());

  return {
    enabled: Boolean(settings[`${gameId}Enabled`]),
    entryCost: effectiveCost,
    maxPlays: effectiveMaxPlays,
    playsToday: plays,
    playsLeft: hasActiveTrivial ? 1 : Math.max(0, effectiveMaxPlays - plays),
    resumable: hasActiveTrivial,
    vacationMode: vacation
  };
}

module.exports = {
  playRasca,
  playTraga,
  playChave,
  getTrivialQuestions,
  startTrivialSession,
  checkTrivialSingleAnswer,
  submitTrivial,
  getStatus
};
