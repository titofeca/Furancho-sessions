const { db } = require('../db/database');
const corcho = require('./corcho');

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

function recordEnxebrePlay(wallet, attempts, solved) {
  const settings = corcho.getEconomySettings();
  if (!settings.enxebreEnabled) throw new Error('Minijuego desactivado');
  
  const today = new Date().toISOString().slice(0, 10);
  
  // Check if played today
  const existing = db.prepare(`SELECT 1 FROM enxebre_history WHERE LOWER(wallet_address) = LOWER(?) AND play_date = ?`).get(wallet, today);
  if (existing) throw new Error('Ya has jugado hoy');

  let awarded = 0;
  if (solved && attempts >= 1 && attempts <= 6) {
    awarded = settings[`enxebrePrize${attempts}`] || 0;
  }

  db.prepare(`
    INSERT INTO enxebre_history (wallet_address, play_date, attempts, solved, awarded_corchos)
    VALUES (?, ?, ?, ?, ?)
  `).run(wallet, today, attempts, solved ? 1 : 0, awarded);

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
  const { deductCorchoCoins } = require('./corcho');
  const deducted = deductCorchoCoins(wallet, cost, 'cunca_pass_cost', `Pasaste A Cunca Quente (-${cost} $CORCHO)`);
  if (!deducted) {
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

module.exports = {
  checkEnxebreGuess,
  recordEnxebrePlay,
  getActiveCunca,
  spawnCunca,
  drinkCunca,
  passCunca
};
