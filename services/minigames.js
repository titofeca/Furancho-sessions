const { db } = require('../db/database');
const corcho = require('./corcho');

// ==================== VACATION MODE ====================
function applyVacationModeCap(wallet, basePrize) {
  const settings = corcho.getEconomySettings();
  if (!settings.vacationMode) return basePrize; // Normal behavior
  
  const maxDaily = parseInt(settings.vacationMaxDailyGameCorchos || 2, 10);
  const today = new Date().toISOString().slice(0, 10);
  
  // Calculate how many minigame corchos they already won today
  const earnedRow = db.prepare(`SELECT SUM(amount) as s FROM corcho_transactions WHERE LOWER(wallet_address) = LOWER(?) AND type LIKE 'minigame_%' AND amount > 0 AND date(created_at) = ?`).get(wallet, today);
  const earned = earnedRow ? (earnedRow.s || 0) : 0;
  
  if (earned >= maxDaily) {
    return 0;
  } else if (earned + basePrize > maxDaily) {
    return maxDaily - earned;
  }
  return basePrize;
}

// ==================== O ENXEBRE (WORDLE) ====================

// Diccionario reducido de 5 letras relacionadas exclusivamente con gastronomía gallega y furancho
const DICT = [
  'CUNCA', 'VIÑOS', 'ZORZA', 'CARNE', 'TAPAS', 
  'POLBO', 'CALDO', 'XAMON', 'PORCO', 'LURAS',
  'XOUBA', 'TAZAS', 'TARTA', 'FOGON', 'PRATO',
  'LICOR', 'MILLO', 'BROAS', 'CHOCA', 'MORRO'
];

function getEnxebreWordForToday() {
  // Use today's date to deterministically pick a word
  const today = new Date().toISOString().slice(0, 10);
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
  
  // First pass: correct position
  for (let i = 0; i < 5; i++) {
    if (guess[i] === target[i]) {
      result.push('correct');
      targetChars[i] = null;
    } else {
      result.push(null);
    }
  }
  
  // Second pass: wrong position
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

  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (existing) {
    if (existing.attempts > 0 || existing.solved === 1) throw new Error('Ya has jugado hoy');
    // Ya está empezada pero sin intentos (recargó la página)
    return { sessionStarted: true, resumed: true };
  }

  const entryCost = settings.enxebreEntryCost || 0;
  if (entryCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, entryCost, 'minigame_enxebre_entry', `🎮 O Enxebre: entrada (-${entryCost} $CORCHO)`);
    if (!res.ok) throw new Error(`Necesitas al menos ${entryCost} $CORCHO para jugar`);
  }

  // Insertar fila inicial
  db.prepare(`
    INSERT INTO enxebre_history (wallet_address, play_date, attempts, solved, awarded_corchos)
    VALUES (?, ?, 0, 0, 0)
  `).run(wallet, today);

  return { sessionStarted: true, entryCost };
}

function recordEnxebrePlay(wallet, attempts, solved) {
  const settings = corcho.getEconomySettings();
  if (!settings.enxebreEnabled) throw new Error('Minijuego desactivado');
  
  const today = new Date().toISOString().slice(0, 10);
  
  // Check if played today
  const existing = db.prepare(`SELECT * FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (!existing) throw new Error('Debes iniciar el juego primero');
  if (existing.attempts > 0 || existing.solved === 1) throw new Error('Ya has terminado el juego hoy');

  let awarded = 0;
  if (solved && attempts >= 1 && attempts <= 6) {
    awarded = settings[`enxebrePrize${attempts}`] || 0;
    awarded = applyVacationModeCap(wallet, awarded);
  }

  db.prepare(`
    UPDATE enxebre_history 
    SET attempts = ?, solved = ?, awarded_corchos = ?
    WHERE id = ?
  `).run(attempts, solved ? 1 : 0, awarded, existing.id);

  if (awarded > 0) {
    const { addCorchoCoins } = require('./corcho');
    addCorchoCoins(
      wallet,
      awarded,
      'minigame_enxebre',
      `🎮 O Enxebre: Acierto en ${attempts} intentos (+${awarded} $CORCHO)`,
      `enxebre_${today}`
    );
  }

  return awarded;
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
    active.history = JSON.parse(active.history);
  } else {
    // Check if any expired that need to be spilled
    db.prepare(`UPDATE cunca_quente SET status = 'spilled' WHERE status = 'active' AND expires_at <= datetime('now')`).run();
  }
  return active;
}

function spawnCunca(targetWallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.cuncaEnabled) throw new Error('Minijuego desactivado');
  
  // Expire current active ones
  db.prepare(`UPDATE cunca_quente SET status = 'spilled' WHERE status = 'active'`).run();
  
  const expires = new Date(Date.now() + (settings.cuncaTimeoutMins * 60000)).toISOString();
  db.prepare(`
    INSERT INTO cunca_quente (status, current_holder, pot_amount, expires_at, history)
    VALUES ('active', ?, ?, ?, '[]')
  `).run(targetWallet, settings.cuncaBasePot, expires);

  // Send push
  const { sendPushToWallet } = require('./push');
  sendPushToWallet(targetWallet, {
    title: '¡A Cunca Quente! 🔥',
    body: `Alguien te ha pasado una cunca con ${settings.cuncaBasePot} $CORCHO. ¡Entra antes de que se derrame!`,
    icon: '/assets/corcho_coin_gold.png'
  });
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

  // Deduct cost
  const { spendCorchoCoins } = require('./corcho');
  const deducted = spendCorchoCoins(wallet, cost, 'cunca_pass_cost', `Pasaste A Cunca Quente (-${cost} $CORCHO)`);
  if (!deducted.ok) {
    throw new Error(`Necesitas al menos ${cost} $CORCHO para pasarla`);
  }

  const newPot = active.pot_amount + cost;
  const newExpires = new Date(Date.now() + (settings.cuncaTimeoutMins * 60000)).toISOString();
  const history = active.history;
  history.push({ from: wallet, to: toWallet, amount: cost, time: new Date().toISOString() });

  db.prepare(`
    UPDATE cunca_quente 
    SET current_holder = ?, pot_amount = ?, expires_at = ?, history = ?
    WHERE id = ?
  `).run(toWallet, newPot, newExpires, JSON.stringify(history), active.id);

  // Send push
  const { sendPushToWallet } = require('./push');
  sendPushToWallet(toWallet, {
    title: '¡A Cunca Quente! 🔥',
    body: `Alguien te ha pasado una cunca con ${newPot} $CORCHO. ¡Entra a la app antes de que se derrame!`,
    icon: '/assets/corcho_coin_gold.png'
  });

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
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM ruleta_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  return {
    enabled: true,
    playsToday: plays.c,
    maxPlays: settings.ruletaMaxPlays,
    canPlay: plays.c < settings.ruletaMaxPlays,
    entryCost: settings.ruletaEntryCost,
    slices: RULETA_SLICES.map((s, i) => ({ name: s.name, index: i, prize: settings[s.key] }))
  };
}

function spinRuleta(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.ruletaEnabled) throw new Error('Minijuego desactivado');

  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM ruleta_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (plays.c >= settings.ruletaMaxPlays) throw new Error('Ya has agotado tus tiradas de hoy');

  const entryCost = settings.ruletaEntryCost;
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

  return { sliceIndex, sliceName: slice.name, prize, playsLeft: settings.ruletaMaxPlays - plays.c - 1 };
}

// ==================== A QUEIMADA ====================

const QUEIMADA_INGREDIENTS = [
  { name: 'Aguardiente',     icon: '🥃', min: 7, max: 10 },
  { name: 'Azúcar',          icon: '🍬', min: 3, max: 5 },
  { name: 'Limón',           icon: '🍋', min: 1, max: 3 },
  { name: 'Café en grano',   icon: '☕', min: 4, max: 6 },
  { name: 'Piel de naranja', icon: '🍊', min: 2, max: 4 },
  { name: 'Orujo de hierbas',icon: '🌿', min: 5, max: 8 },
  { name: 'Miel',            icon: '🍯', min: 2, max: 4 },
  { name: 'Canela',          icon: '🪵', min: 1, max: 3 }
];

function getQueimadaStatus(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.queimadaEnabled) return { enabled: false };
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  return {
    enabled: true,
    playsToday: plays.c,
    maxPlays: settings.queimadaMaxPlays,
    canPlay: plays.c < settings.queimadaMaxPlays,
    entryCost: settings.queimadaEntryCost
  };
}

function startQueimada(wallet) {
  const settings = corcho.getEconomySettings();
  if (!settings.queimadaEnabled) throw new Error('Minijuego desactivado');

  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (plays.c >= settings.queimadaMaxPlays) throw new Error('Ya has agotado tus queimadas de hoy');

  const entryCost = settings.queimadaEntryCost;
  if (entryCost > 0) {
    const { spendCorchoCoins } = require('./corcho');
    const res = spendCorchoCoins(wallet, entryCost, 'minigame_queimada_entry', `🔥 A Queimada: entrada (-${entryCost} $CORCHO)`);
    if (!res.ok) throw new Error(`Necesitas al menos ${entryCost} $CORCHO para jugar`);
  }

  return { sessionStarted: true, entryCost };
}

function drawIngredient() {
  const ing = QUEIMADA_INGREDIENTS[Math.floor(Math.random() * QUEIMADA_INGREDIENTS.length)];
  const value = ing.min + Math.floor(Math.random() * (ing.max - ing.min + 1));
  return { name: ing.name, icon: ing.icon, value };
}

function resolveQueimada(wallet, ingredients, totalScore) {
  const settings = corcho.getEconomySettings();
  const today = new Date().toISOString().slice(0, 10);
  const entryCost = settings.queimadaEntryCost;

  let result, prize = 0;
  if (totalScore > 21) {
    result = 'burned';
  } else if (totalScore === 21) {
    result = 'perfect';
    prize = entryCost * (settings.queimadaMult21 || 3);
  } else if (totalScore >= 18) {
    result = 'great';
    prize = entryCost * (settings.queimadaMult1820 || 2);
  } else if (totalScore >= 15) {
    result = 'good';
    prize = entryCost * (settings.queimadaMult1517 || 1);
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
    addCorchoCoins(wallet, prize, 'minigame_queimada', `🔥 A Queimada: ${result === 'perfect' ? '¡Perfecta!' : result === 'great' ? 'Casi perfecta' : 'Pasable'} (+${prize} $CORCHO)`, `queimada_${today}_${Date.now()}`);
  }

  const plays = db.prepare(`SELECT COUNT(*) as c FROM queimada_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);

  return { result, prize, totalScore, playsLeft: settings.queimadaMaxPlays - plays.c };
}

module.exports = {
  checkEnxebreGuess,
  startEnxebre,
  recordEnxebrePlay,
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
