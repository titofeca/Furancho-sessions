const { db } = require('../db/database');
const corcho = require('./corcho');

function getMadridDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

// ==================== VACATION MODE ====================
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

// ==================== O ENXEBRE (WORDLE FURANCHEIRO) ====================
const DICT = [
  'CUNCA', 'VIÑOS', 'ZORZA', 'CARNE', 'TAPAS',
  'POLBO', 'CALDO', 'XAMON', 'PORCO', 'LURAS',
  'XOUBA', 'TAZAS', 'TARTA', 'FOGON', 'PRATO',
  'LICOR', 'MILLO', 'BROAS', 'CHOCA', 'MORRO',
  'ADEGA', 'PIPAS', 'BRASA', 'LACON', 'GRELO',
  ' ORUXO'.trim(), 'FEIRA', ' ALDEA'.trim(), 'CUBA' .padEnd(5, 'S')
];

// Asegurar columna guesses_json para seguimiento real en servidor (anti-trampa)
try {
  const cols = new Set(db.prepare(`PRAGMA table_info(enxebre_history)`).all().map(c => c.name));
  if (!cols.has('guesses_json')) {
    db.exec(`ALTER TABLE enxebre_history ADD COLUMN guesses_json TEXT DEFAULT '[]'`);
  }
} catch (_) {}

function getEnxebreWordForToday() {
  const today = getMadridDateStr();
  let hash = 0;
  for (let i = 0; i < today.length; i++) {
    hash = ((hash << 5) - hash) + today.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % DICT.length;
  return DICT[index];
}

function checkEnxebreGuess(guess) {
  const target = getEnxebreWordForToday();
  const result = [];
  const targetChars = target.split('');

  for (let i = 0; i < 5; i++) {
    if (guess[i] === target[i]) {
      result.push('correct');
      targetChars[i] = null;
    } else {
      result.push(null);
    }
  }

  for (let i = 0; i < 5; i++) {
    if (result[i] === null) {
      const idx = targetChars.indexOf(guess[i]);
      if (idx !== -1) {
        result[i] = 'present';
        targetChars[idx] = null;
      } else {
        result[i] = 'absent';
      }
    }
  }

  return result;
}

function startEnxebre(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.enxebreEnabled) throw new Error('Minijuego desactivado');

  const today = getMadridDateStr();
  const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (existing) {
    let prevGuesses = [];
    try { prevGuesses = JSON.parse(existing.guesses_json || '[]'); } catch (_) {}
    if (existing.solved === 1 || prevGuesses.length >= 6 || existing.attempts >= 6) {
      throw new Error('Ya has jugado hoy');
    }
    return {
      sessionStarted: true,
      resumed: true,
      previousGuesses: prevGuesses.map(g => ({ guess: g, result: checkEnxebreGuess(g) }))
    };
  }

  const baseEntryCost = settings.enxebreEntryCost || 0;
  const entryCost = settings.vacationMode ? 0 : baseEntryCost;
  if (entryCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, entryCost, 'minigame_enxebre_entry', `🪵 O Enxebre: entrada (-${entryCost} $CORCHO)`);
    if (!res.ok) throw new Error(`Necesitas al menos ${entryCost} $CORCHO para jugar`);
  }

  db.prepare(`
    INSERT INTO enxebre_history (wallet_address, play_date, attempts, solved, awarded_corchos, guesses_json)
    VALUES (?, ?, 0, 0, 0, '[]')
  `).run(wallet, today);

  return { sessionStarted: true, entryCost, previousGuesses: [] };
}

function submitEnxebreGuess(wallet, rawGuess) {
  const settings = corcho.getEconomySettings();
  if (!settings.enxebreEnabled) throw new Error('Minijuego desactivado');

  const guess = String(rawGuess || '').trim().toUpperCase();
  if (guess.length !== 5) throw new Error('La palabra debe tener 5 letras');

  const today = getMadridDateStr();
  let existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (!existing) {
    // Auto-start si coste es 0 para máxima fluidez
    startEnxebre(wallet);
    existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  }

  let prevGuesses = [];
  try { prevGuesses = JSON.parse(existing.guesses_json || '[]'); } catch (_) {}
  if (existing.solved === 1 || prevGuesses.length >= 6) {
    throw new Error('Ya has terminado la partida de hoy');
  }

  prevGuesses.push(guess);
  const attempts = prevGuesses.length;
  const result = checkEnxebreGuess(guess);
  const solved = result.every(r => r === 'correct');
  let awarded = 0;

  if (solved && attempts >= 1 && attempts <= 6) {
    awarded = settings[`enxebrePrize${attempts}`] || 0;
    awarded = applyVacationModeCap(wallet, awarded);
  }

  const finished = solved || attempts >= 6;
  db.prepare(`
    UPDATE enxebre_history
    SET attempts = ?, solved = ?, awarded_corchos = ?, guesses_json = ?
    WHERE id = ?
  `).run(attempts, solved ? 1 : 0, finished ? awarded : 0, JSON.stringify(prevGuesses), existing.id);

  if (solved && awarded > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(
      wallet,
      awarded,
      'minigame_enxebre',
      `🪵 O Enxebre: Acierto en ${attempts} intento${attempts > 1 ? 's' : ''} (+${awarded} $CORCHO)`,
      `enxebre_${today}`
    );
  }
  if (finished) {
    try { corcho.grantReopeningTicket(wallet, 'minigame_enxebre'); } catch (_) {}
  }

  return {
    result,
    solved,
    awarded,
    attempts,
    finished,
    targetWord: (!solved && finished) ? getEnxebreWordForToday() : undefined
  };
}

// ==================== A CUNCA QUENTE ====================
function getActiveCunca() {
  const settings = corcho.getEconomySettings();
  if (!settings.cuncaEnabled) return null;

  const active = db.prepare(`
    SELECT * FROM cunca_quente
    WHERE status = 'active' AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get();

  if (active) {
    try { active.history = JSON.parse(active.history || '[]'); } catch (_) { active.history = []; }
  } else {
    db.prepare(`UPDATE cunca_quente SET status = 'spilled' WHERE status = 'active' AND expires_at <= datetime('now')`).run();
  }
  return active;
}

function spawnCunca(targetWallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.cuncaEnabled) throw new Error('Minijuego desactivado');

  db.prepare(`UPDATE cunca_quente SET status = 'spilled' WHERE status = 'active'`).run();

  const expires = new Date(Date.now() + (settings.cuncaTimeoutMins * 60000)).toISOString();
  db.prepare(`
    INSERT INTO cunca_quente (status, current_holder, pot_amount, expires_at, history)
    VALUES ('active', ?, ?, ?, '[]')
  `).run(targetWallet, settings.cuncaBasePot, expires);

  const { sendPushToWallet } = require('./push');
  sendPushToWallet(
    targetWallet,
    '¡A Cunca Quente! 🔥',
    `Alguien te ha pasado una cunca con ${settings.cuncaBasePot} $CORCHO. ¡Entra antes de que se derrame!`,
    { icon: '/assets/corcho_coin_gold.png', url: '/claim' }
  ).catch(() => {});
}

function drinkCunca(wallet) {
  const active = getActiveCunca();
  if (!active || active.current_holder.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('No tienes la Cunca Quente o ya caducó');
  }

  db.prepare(`UPDATE cunca_quente SET status = 'claimed' WHERE id = ?`).run(active.id);

  const { addCorchoCoins } = require('./corcho');
  addCorchoCoins(
    wallet,
    active.pot_amount,
    'minigame_cunca',
    `🍷 Bebiste A Cunca Quente (+${active.pot_amount} $CORCHO)`,
    `cunca_drink_${active.id}`
  );

  return active.pot_amount;
}

function passCunca(wallet, toWallet) {
  const active = getActiveCunca();
  if (!active || active.current_holder.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('No tienes la Cunca Quente o ya caducó');
  }
  if (wallet.toLowerCase() === toWallet.toLowerCase()) {
    throw new Error('No te la puedes pasar a ti mismo');
  }

  const settings = corcho.getEconomySettings();
  const cost = settings.cuncaPassCost || 5;

  const { spendCorchoCoins } = require('./corcho');
  const deducted = spendCorchoCoins(wallet, cost, 'cunca_pass_cost', `Pasaste A Cunca Quente (-${cost} $CORCHO)`);
  if (!deducted.ok) {
    throw new Error(`Necesitas al menos ${cost} $CORCHO para pasarla`);
  }

  const newPot = active.pot_amount + cost;
  const newExpires = new Date(Date.now() + (settings.cuncaTimeoutMins * 60000)).toISOString();
  const history = Array.isArray(active.history) ? active.history : [];
  history.push({ from: wallet, to: toWallet, amount: cost, time: new Date().toISOString() });

  db.prepare(`
    UPDATE cunca_quente
    SET current_holder = ?, pot_amount = ?, expires_at = ?, history = ?
    WHERE id = ?
  `).run(toWallet, newPot, newExpires, JSON.stringify(history), active.id);

  const { sendPushToWallet } = require('./push');
  sendPushToWallet(
    toWallet,
    '¡A Cunca Quente! 🔥',
    `Alguien te ha pasado una cunca con ${newPot} $CORCHO. ¡Entra a la app antes de que se derrame!`,
    { icon: '/assets/corcho_coin_gold.png', url: '/claim' }
  ).catch(() => {});

  return newPot;
}

// ==================== A RULETA DO PULPO ====================
const RULETA_SLICES = [
  { name: 'Tentáculo seco',  key: 'ruletaSlice0' },
  { name: 'Pimentón frío',   key: 'ruletaSlice1' },
  { name: 'Cacheira seca',   key: 'ruletaSlice2' },
  { name: 'Sal grosa',       key: 'ruletaSlice3' },
  { name: 'Pimentón bueno',  key: 'ruletaSlice4' },
  { name: 'Aceite da casa',  key: 'ruletaSlice5' },
  { name: 'Feira de Lugo',   key: 'ruletaSlice6' },
  { name: 'Pulpo de Ouro',   key: 'ruletaSlice7' }
];

function getRuletaStatus(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.ruletaEnabled) return { enabled: false };
  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM ruleta_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings.ruletaMaxPlays || 1);
  const effectiveCost = vacation ? 0 : (settings.ruletaEntryCost || 0);
  return {
    enabled: true,
    playsToday: plays.c,
    maxPlays: effectiveMaxPlays,
    canPlay: plays.c < effectiveMaxPlays,
    entryCost: effectiveCost,
    vacationMode: vacation,
    slices: RULETA_SLICES.map((s, i) => ({ name: s.name, index: i, prize: settings[s.key] }))
  };
}

function spinRuleta(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.ruletaEnabled) throw new Error('Minijuego desactivado');

  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM ruleta_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings.ruletaMaxPlays || 1);
  if (plays.c >= effectiveMaxPlays) {
    throw new Error(vacation ? '🏖️ Modo Vacaciones: Solo puedes girar 3 veces al día' : 'Ya has agotado tus tiradas de hoy');
  }

  const baseRuletaCost = settings.ruletaEntryCost || 0;
  const entryCost = vacation ? 0 : baseRuletaCost;
  if (entryCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, entryCost, 'minigame_ruleta_entry', `🐙 Ruleta do Pulpo: entrada (-${entryCost} $CORCHO)`);
    if (!res.ok) throw new Error(`Necesitas al menos ${entryCost} $CORCHO para girar`);
  }

  const sliceIndex = Math.floor(Math.random() * 8);
  const slice = RULETA_SLICES[sliceIndex];
  let prize = settings[slice.key] || 0;
  prize = applyVacationModeCap(wallet, prize);

  db.prepare(`
    INSERT INTO ruleta_history (wallet_address, play_date, entry_cost, slice_index, slice_name, awarded_corchos)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wallet, today, entryCost, sliceIndex, slice.name, prize);

  if (prize > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(wallet, prize, 'minigame_ruleta', `🐙 Ruleta do Pulpo: ${slice.name} (+${prize} $CORCHO)`, `ruleta_${today}_${plays.c}`);
  }

  try {
    corcho.grantReopeningTicket(wallet, 'minigame_ruleta');
  } catch (_) {}

  return { sliceIndex, sliceName: slice.name, prize, playsLeft: Math.max(0, effectiveMaxPlays - plays.c - 1) };
}

// ==================== A QUEIMADA (SERVER-AUTHORITATIVE) ====================
const QUEIMADA_INGREDIENTS = [
  { name: 'Aguardiente da Ulla', icon: '🥃', min: 7, max: 10 },
  { name: 'Azúcar blanco',       icon: '🍬', min: 3, max: 5 },
  { name: 'Monda de limón',      icon: '🍋', min: 1, max: 3 },
  { name: 'Café en grano',       icon: '☕', min: 4, max: 6 },
  { name: 'Piel de naranja',     icon: '🍊', min: 2, max: 4 },
  { name: 'Orujo de hierbas',    icon: '🌿', min: 5, max: 8 },
  { name: 'Miel de brezo',       icon: '🍯', min: 2, max: 4 },
  { name: 'Rama de canela',      icon: '🪵', min: 1, max: 3 }
];

// Sesiones activas en servidor para evitar resolver sin haber pagado entrada ni inventar ingredientes
const _activeQueimadas = new Map();

function getQueimadaStatus(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.queimadaEnabled) return { enabled: false };
  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings.queimadaMaxPlays || 1);
  const effectiveCost = vacation ? 0 : (settings.queimadaEntryCost || 0);
  const wKey = wallet.toLowerCase();
  const activeSession = _activeQueimadas.get(wKey);
  return {
    enabled: true,
    playsToday: plays.c,
    maxPlays: effectiveMaxPlays,
    canPlay: plays.c < effectiveMaxPlays || !!activeSession,
    entryCost: effectiveCost,
    vacationMode: vacation,
    activeSession: activeSession || null
  };
}

function startQueimada(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.queimadaEnabled) throw new Error('Minijuego desactivado');

  const wKey = wallet.toLowerCase();
  if (_activeQueimadas.has(wKey)) {
    const sess = _activeQueimadas.get(wKey);
    return { sessionStarted: true, resumed: true, entryCost: sess.entryCost, ingredients: sess.ingredients, totalScore: sess.score };
  }

  const today = getMadridDateStr();
  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings.queimadaMaxPlays || 1);
  if (plays.c >= effectiveMaxPlays) {
    throw new Error(vacation ? '🏖️ Modo Vacaciones: Solo puedes hacer 3 queimadas al día' : 'Ya has agotado tus queimadas de hoy');
  }

  const baseQueimadaCost = settings.queimadaEntryCost || 0;
  const entryCost = vacation ? 0 : baseQueimadaCost;
  if (entryCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, entryCost, 'minigame_queimada_entry', `🔥 A Queimada: entrada (-${entryCost} $CORCHO)`);
    if (!res.ok) throw new Error(`Necesitas al menos ${entryCost} $CORCHO para jugar`);
  }

  _activeQueimadas.set(wKey, { today, entryCost, ingredients: [], score: 0, startedAt: Date.now() });
  return { sessionStarted: true, entryCost };
}

function drawIngredient(wallet) {
  const wKey = String(wallet || '').toLowerCase();
  const sess = _activeQueimadas.get(wKey);
  if (!sess) throw new Error('Debes encender la Queimada primero');
  if (sess.score > 21) throw new Error('La Queimada ya se pasó de fuego');

  const ing = QUEIMADA_INGREDIENTS[Math.floor(Math.random() * QUEIMADA_INGREDIENTS.length)];
  const value = ing.min + Math.floor(Math.random() * (ing.max - ing.min + 1));
  const drawn = { name: ing.name, icon: ing.icon, value };
  sess.ingredients.push(drawn);
  sess.score += value;
  return { ...drawn, totalScore: sess.score };
}

function resolveQueimada(wallet) {
  const settings = corcho.getEconomySettings();
  const wKey = String(wallet || '').toLowerCase();
  const sess = _activeQueimadas.get(wKey);
  if (!sess) {
    throw new Error('No hay ninguna Queimada activa. Pulsa Empezar primero.');
  }
  _activeQueimadas.delete(wKey);

  const today = sess.today || getMadridDateStr();
  const totalScore = sess.score;
  const ingredients = sess.ingredients;
  const baseCostForPrize = settings.queimadaEntryCost || 1;
  const entryCost = sess.entryCost;

  let result, prize = 0;
  if (totalScore > 21) {
    result = 'burned';
  } else if (totalScore === 21) {
    result = 'perfect';
    prize = baseCostForPrize * (settings.queimadaMult21 || 3);
  } else if (totalScore >= 18) {
    result = 'great';
    prize = baseCostForPrize * (settings.queimadaMult1820 || 2);
  } else if (totalScore >= 15) {
    result = 'good';
    prize = baseCostForPrize * (settings.queimadaMult1517 || 1);
  } else {
    result = 'weak';
  }

  prize = applyVacationModeCap(wallet, prize);

  db.prepare(`
    INSERT INTO queimada_history (wallet_address, play_date, entry_cost, ingredients, total_score, result, awarded_corchos)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(wallet, today, entryCost, JSON.stringify(ingredients), totalScore, result, prize);

  if (prize > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(wallet, prize, 'minigame_queimada', `🔥 A Queimada: ${result === 'perfect' ? '¡Conxuro Perfecto (21)!' : result === 'great' ? '¡Moi boa!' : 'No seu punto'} (+${prize} $CORCHO)`, `queimada_${today}_${Date.now()}`);
  }

  try {
    corcho.grantReopeningTicket(wallet, 'minigame_queimada');
  } catch (_) {}

  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  const effectiveMaxPlays = settings.vacationMode ? 3 : (settings.queimadaMaxPlays || 1);

  return { result, prize, totalScore, playsLeft: Math.max(0, effectiveMaxPlays - plays.c) };
}

module.exports = {
  getMadridDateStr,
  checkEnxebreGuess,
  startEnxebre,
  submitEnxebreGuess,
  getActiveCunca,
  spawnCunca,
  drinkCunca,
  passCunca,
  getRuletaStatus,
  spinRuleta,
  getQueimadaStatus,
  startQueimada,
  drawIngredient,
  resolveQueimada,
  RULETA_SLICES,
  QUEIMADA_INGREDIENTS
};
