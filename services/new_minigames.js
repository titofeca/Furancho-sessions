const { db } = require('../db/database');
const corcho = require('./corcho');

// Helper para Límite Vacaciones (igual que en minigames.js)
function applyVacationModeCap(wallet, basePrize) {
  const settings = corcho.getEconomySettings();
  if (!settings.vacationMode) return basePrize;
  const maxDaily = parseInt(settings.vacationMaxDailyGameCorchos || 2, 10);
  const today = new Date().toISOString().slice(0, 10);
  const earnedRow = db.prepare(`SELECT SUM(amount) as s FROM corcho_transactions WHERE LOWER(wallet_address) = LOWER(?) AND type LIKE 'minigame_%' AND amount > 0 AND date(created_at) = ?`).get(wallet, today);
  const earned = earnedRow ? (earnedRow.s || 0) : 0;
  if (earned >= maxDaily) return 0;
  if (earned + basePrize > maxDaily) return maxDaily - earned;
  return basePrize;
}

// Helper genérico para registro y validación
function checkAndCharge(wallet, gameId, entryCost, maxPlays) {
  const settings = corcho.getEconomySettings();
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;

  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : maxPlays;
  if (plays >= effectiveMaxPlays) {
    throw new Error(vacation ? '🏖️ Modo Vacaciones: Solo se puede jugar hasta 3 veces al día a cada juego' : 'Límite diario alcanzado');
  }

  // En modo vacaciones los juegos son GRATIS 🏖️
  const effectiveCost = vacation ? 0 : entryCost;

  if (effectiveCost > 0) {
    const { getCorchoBalance, spendCorchoCoins } = require('./corcho');
    const balance = getCorchoBalance(wallet);
    if (balance < effectiveCost) throw new Error('Saldo insuficiente');
    spendCorchoCoins(wallet, effectiveCost, `minigame_${gameId}_entry`, `Entrada a ${gameId}`);
  }
  return { playsToday: plays, today, effectiveCost };
}

function recordPlayAndReward(wallet, gameId, today, entryCost, rawPrize, prizeDesc) {
  const finalPrize = applyVacationModeCap(wallet, rawPrize);
  db.prepare(`INSERT INTO minigame_plays (wallet_address, game_id, play_date, cost, won) VALUES (?, ?, ?, ?, ?)`).run(wallet, gameId, today, entryCost, finalPrize);
  if (finalPrize > 0) {
    const { addCorchoCoins } = require('./corcho');
    const desc = prizeDesc ? `${prizeDesc} (+${finalPrize} $CORCHO)` : `Premio ${gameId} (+${finalPrize} $CORCHO)`;
    addCorchoCoins(wallet, finalPrize, `minigame_${gameId}`, desc, `${gameId}_${Date.now()}`);
  }
  // Otorgar 1 boleto automático por cada partida jugada para el sorteo de reapertura
  try {
    const { grantReopeningTicket } = require('./corcho');
    grantReopeningTicket(wallet, `minigame_${gameId}`);
  } catch (_) {}
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

  const finalPrize = recordPlayAndReward(wallet, 'rasca', today, settings.rascaEntryCost, rawPrize, '🎟️ Rasca y Gana');
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

  const finalPrize = recordPlayAndReward(wallet, 'traga', today, settings.tragaEntryCost, rawPrize, '🎰 Tragaperras');
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

  const finalPrize = recordPlayAndReward(wallet, 'chave', today, settings.chaveEntryCost, rawPrize, '🎯 A Chave');
  return { result: hitType, prize: finalPrize, rawPrize, timing: userTiming };
}

// ==================== 4. TRIVIAL ====================
const TRIVIAL_DB = [
  { q: '¿Qué es un Furancho?', o: ['Un barco pesquero', 'Una bodega familiar que vende su vino excedente', 'Un baile tradicional', 'Un postre de carnaval'], a: 1 },
  { q: '¿Qué colocan tradicionalmente en la entrada para señalar que el furancho tiene vino?', o: ['Una bandera roja', 'Una rama de laurel (loendro)', 'Una cunca de madera', 'Una linterna encendida'], a: 1 },
  { q: '¿Cómo se llaman las tazas tradicionales de cerámica blanca donde se bebe el vino?', o: ['Cuncas', 'Copas de cristal', 'Porrones', 'Jarras de bronce'], a: 0 },
  { q: '¿Qué uva blanca es la reina indiscutible de la D.O. Rías Baixas?', o: ['Mencía', 'Albariño', 'Godello', 'Palomino'], a: 1 },
  { q: '¿Qué tapa tradicional furancheira consiste en lomo de cerdo adobado con pimentón?', o: ['Raxo', 'Zorza', 'Laconada', 'Empanada'], a: 1 },
  { q: '¿En qué mes abre tradicionalmente la temporada de furanchos en Galicia?', o: ['Agosto', 'Enero / Febrero', 'Noviembre', 'Julio'], a: 1 },
  { q: '¿Qué variedad de uva tinta predomina en los vinos de la Ribeira Sacra?', o: ['Mencía', 'Tempranillo', 'Garnacha', 'Cabernet'], a: 0 },
  { q: '¿Cómo se llama la cazuela de barro donde se arde el aguardiente con azúcar y frutas?', o: ['Cunca de barro', 'Pote de queimada', 'Tarta de santiago', 'Caldeira'], a: 1 },
  { q: '¿Qué ingrediente imprescindible da color y picante a la pulpo á feira?', o: ['Ajo molido', 'Pimentón (dulce y picante)', 'Pimienta negra', 'Guindilla seca'], a: 1 },
  { q: '¿De qué famosa localidad de Pontevedra son los afamados pimientos "uns pican e outros non"?', o: ['Herbón / Padrón', 'Cambados', 'Redondela', 'Combarro'], a: 0 },
  { q: '¿Qué tipo de pan elaborado con harina de maíz es el acompañamiento ideal del vino nuevo?', o: ['Pan de mollete', 'Pan de millo (Broa)', 'Baguette', 'Pan de centeno puro'], a: 1 },
  { q: '¿En qué municipio se celebra a principios de agosto la mítica Festa do Albariño?', o: ['O Porriño', 'Cambados', 'Vigo', 'Sanxenxo'], a: 1 },
  { q: '¿Qué ensaladilla o tapa furancheira de pescado frito pequeño en conserva es un clásico?', o: ['Xoubas fritas', 'Sardinas asadas', 'Chinchartos', 'Boquerones en vinagre'], a: 0 },
  { q: '¿Qué cabo de la costa gallega era considerado el fin del mundo ("Finis Terrae") por los romanos?', o: ['Cabo Ortegal', 'Cabo Fisterra', 'Cabo de Gata', 'Cabo Estaca de Bares'], a: 1 },
  { q: '¿Qué caldo tradicional se prepara con grelos, alubias blancas, patatas y un toque de sazón de cerdo?', o: ['Sopa de marisco', 'Caldo galego', 'Gazpacho', 'Consomé de carne'], a: 1 },
  { q: '¿Qué dulce de almendra tostada con la Cruz de Santiago es el más célebre de Galicia?', o: ['Bica galega', 'Tarta de Santiago', 'Filloa rellena', 'Rosca de anís'], a: 1 },
  { q: '¿Qué fruto seco asado es la estrella indudable de las fiestas del "Magosto" en otoño?', o: ['Nuez', 'Castaña', 'Avellana', 'Almendra'], a: 1 },
  { q: '¿Cómo se denomina en gallego al destilado blanco elaborado con los orujos de las uvas?', o: ['Licor café', 'Caña / Aguardiente de orujo', 'Orujo de hierbas', 'Crema de orujo'], a: 1 },
  { q: '¿Qué danza tradicional gallega se baila al alegre compás de la gaita y el tamboril?', o: ['Muñeira (Muiñeira)', 'Jota aragonesa', 'Flamenco', 'Sardana'], a: 0 },
  { q: '¿Qué emblemático faro romano en A Coruña es el más antiguo del mundo aún en funcionamiento?', o: ['Faro de Fisterra', 'Torre de Hércules', 'Faro de Cíes', 'Faro de Ons'], a: 1 },
  { q: '¿Qué marisco sin concha ni patas es el plato rey de las ferias gallegas cocido en caldera de cobre?', o: ['Centollo', 'Pulpo (Polbo)', 'Nécora', 'Bogavante'], a: 1 },
  { q: '¿Qué árbol autóctono gallego da el roble sagrado de los bosques o carballeiras?', o: ['Carballo (Roble)', 'Eucalipto', 'Pino', 'Castaño'], a: 0 },
  { q: '¿Qué queso cónico elaborado con leche de vaca cuenta con Denominación de Origen Protegida?', o: ['Queso San Simón', 'Queso Tetilla', 'Queso Cebreiro', 'Queso Arzúa'], a: 1 },
  { q: '¿En qué ría gallega se ubica el impresionante archipiélago de las Islas Cíes?', o: ['Ría de Arousa', 'Ría de Vigo', 'Ría de Pontevedra', 'Ría de Muros'], a: 1 },
  { q: '¿Qué nombre recibe la tapa de carne de cerdo adobada cortada a dados frita en la sartén?', o: ['Zorza', 'Raxo', 'Zorza con patatas', 'Lacón'], a: 1 },
  { q: '¿Qué uva blanca aromática es célebre en los viñedos del río Avia en la D.O. Ribeiro?', o: ['Treixadura', 'Torrontés', 'Godello', 'Loureira'], a: 0 },
  { q: '¿Qué licor de color oscuro y sabor dulce se elabora infusionando café en agua de caña?', o: ['Licor de hierbas', 'Licor café', 'Crema de orujo', 'Anisete'], a: 1 },
  { q: '¿Qué embarcación tradicional gallega de fondo plano navegaba a remo o vela por las rías?', o: ['Gamela / Dorna', 'Carabela', 'Catamarán', 'Piragua'], a: 0 },
  { q: '¿De qué color es la franja diagonal que adorna la bandera oficial de Galicia?', o: ['Verde', 'Azul celeste', 'Roja', 'Amarilla'], a: 1 },
  { q: '¿Qué flor silvestre amarilla o adorno vegetal se usa en la festividad primaveral de "Os Maios"?', o: ['Gesta / Toxos e maios', 'Margaritas', 'Rosas', 'Girasoles'], a: 0 },
  { q: '¿Qué marisco de cáscara y patas largas se subasta con gran valor en la lonja de O Grove?', o: ['Centollo de la ría', 'Calamar', 'Almeja fina', 'Navaja'], a: 0 },
  { q: '¿En qué provincia se ubica la espectacular comarca vitivinícola de la Ribeira Sacra?', o: ['Lugo y Ourense', 'A Coruña', 'Pontevedra', 'Asturias'], a: 0 },
  { q: '¿Qué hortaliza de hoja verde, brote suave del nabo, es esencial en el cocido galleguísimo?', o: ['Grelos', 'Berzas', 'Espinacas', 'Acelgas'], a: 0 },
  { q: '¿Qué marisco sabroso se extrae a mano de las rocas batidas por las olas en los acantilados?', o: ['Percebe', 'Mejillón', 'Ostra', 'Cigala'], a: 0 },
  { q: '¿Qué célebre cascada de la costa da Morte es la única de Europa que cae directamente al mar?', o: ['Cascada del Ézaro', 'Fervenza do Toxa', 'Cascada de Faba', 'Fervenza do Belelle'], a: 0 },
  { q: '¿Qué expresión de brindis en gallego celebra la amistad al chocar las cuncas de vino?', o: ['¡Salud e terra no funil!', '¡Buen provecho!', '¡Hasta luego!', '¡Arriba y abajo!'], a: 0 },
  { q: '¿Qué postre en láminas finísimas estilo crepe es tradicional en los carnavales gallegos?', o: ['Filloas', 'Orejas de carnaval', 'Churros', 'Bica de Trives'], a: 0 },
  { q: '¿Qué recipiente tradicional de madera o barro servía para almacenar el vino en las bodegas?', o: ['Pipote / Barrica', 'Garrafa', 'Botella de vidrio', 'Damajuana'], a: 0 },
  { q: '¿En qué ría gallega se sitúa la pintoresca villa marinera de Combarro con sus hórreos al mar?', o: ['Ría de Pontevedra', 'Ría de Betanzos', 'Ría de Ferrol', 'Ría de Aldán'], a: 0 },
  { q: '¿Qué embutido curado ahumado cocido se sirve típicamente en las zonas de montaña de Ourense?', o: ['Androlla / Botelo', 'Salchichón', 'Chorizo criollo', 'Chistorra'], a: 0 },
  { q: '¿Qué isla pontevedresa es célebre por sus polbos cocidos en la isla y sus playas vírgenes?', o: ['Isla de Ons', 'Isla de Sálvora', 'Isla de Cortegada', 'Isla de Tambo'], a: 0 },
  { q: '¿Qué juego de puntería popular consiste en lanzar discos de hierro a una hendidura sobre un pie de granito?', o: ['A Chave', 'Petanca', 'Bolos celtas', 'Tiro con arco'], a: 0 },
  { q: '¿Qué planta o arbusto aromático se quema tradicionalmente para ahuyentar a las meigas?', o: ['Romero / Toxeira', 'Hierbabuena', 'Menta', 'Eucalipto dulce'], a: 0 },
  { q: '¿Qué tipo de vino galleguísimo destaca por ser joven, fresco, ácido y servido en cunca?', o: ['Vino de furancho (Vino de país)', 'Vino reserva de 10 años', 'Cava brutal', 'Vermú industrial'], a: 0 },
  { q: '¿En qué comarca del sur de Pontevedra es legendario el concurso del "Furancho Máis Enxebre"?', o: ['O Salnés / O Morrazo / Redondela', 'Ordes', 'Barbanza', 'Terra Chá'], a: 0 },
  { q: '¿Qué pez pequeño frito entero con espina es un bocado crujiente ideal en las tascas?', o: ['Parrochitas / Xoubiñas', 'Merluza', 'Bacalao', 'Lenguado'], a: 0 },
  { q: '¿Qué dulce de bizcocho esponjoso con costra de azúcar es típico de la villa de Castro Caldelas?', o: ['Bica mantechada', 'Tarta de pisa', 'Cañas de O Barco', 'Melindres'], a: 0 },
  { q: '¿Qué elemento de piedra elevado sobre pies circulares servía para proteger el grano de los ratones?', o: ['Hórreo (Eira / Canastro)', 'Cruceiro', 'Peto de ánimas', 'Pazo'], a: 0 },
  { q: '¿Qué cantante / grupo de música tradicional gallega ha llevado la muiñeira a festivales internacionales?', o: ['Tanxugueiras / Carlos Núñez', 'Mecano', 'Fito & Fitipaldis', 'Estopa'], a: 0 },
  { q: '¿Qué espíritu de la mitología gallega vaga en procesión nocturna por las aldeas según la leyenda?', o: ['A Santa Compaña', 'O Trasno', 'A Moura', 'O Lavandeira'], a: 0 }
];

function getTrivialQuestions(walletAddress) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const walletHash = (walletAddress || '').toLowerCase().split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const dateHash = todayStr.split('-').reduce((acc, part) => acc + parseInt(part, 10), 0);
  
  // Utilizar semilla determinista combinando día + wallet para rotar preguntas de forma inteligente
  const seed = (walletHash * 31 + dateHash * 17) % TRIVIAL_DB.length;
  
  const selected = [];
  const total = TRIVIAL_DB.length;
  for (let i = 0; i < 3; i++) {
    const idx = (seed + i * 7 + (i * i * 3)) % total;
    const item = TRIVIAL_DB[idx];
    selected.push({
      id: idx,
      q: item.q,
      o: item.o,
      _a: item.a
    });
  }

  return selected;
}

function submitTrivial(wallet, userParam) {
  const settings = corcho.getEconomySettings();
  if (!settings.trivialEnabled) throw new Error('Trivial desactivado');
  const { today } = checkAndCharge(wallet, 'trivial', settings.trivialEntryCost, settings.trivialMaxPlays);
  
  let won = false;
  if (Array.isArray(userParam)) {
    const questions = getTrivialQuestions(wallet);
    won = (userParam.length === questions.length) && questions.every((q, idx) => Number(userParam[idx]) === q._a);
  } else if (userParam && typeof userParam === 'object' && Array.isArray(userParam.answers)) {
    const questions = getTrivialQuestions(wallet);
    won = (userParam.answers.length === questions.length) && questions.every((q, idx) => Number(userParam.answers[idx]) === q._a);
  } else if (typeof userParam === 'boolean') {
    won = userParam;
  }

  let rawPrize = won ? settings.trivialPrize : 0;
  const finalPrize = recordPlayAndReward(wallet, 'trivial', today, settings.trivialEntryCost, rawPrize, '🧠 Trivial');
  return { prize: finalPrize, rawPrize, won };
}

function getStatus(wallet, gameId) {
  const settings = corcho.getEconomySettings();
  const today = new Date().toISOString().slice(0, 10);
  const plays = db.prepare(`SELECT COUNT(*) as c FROM minigame_plays WHERE LOWER(wallet_address) = LOWER(?) AND game_id = ? AND play_date = ?`).get(wallet, gameId, today).c;
  
  const vacation = !!settings.vacationMode;
  const effectiveMaxPlays = vacation ? 3 : (settings[`${gameId}MaxPlays`] || 1);
  const effectiveCost = vacation ? 0 : (settings[`${gameId}EntryCost`] || 0);

  return {
    enabled: Boolean(settings[`${gameId}Enabled`]),
    entryCost: effectiveCost,
    maxPlays: effectiveMaxPlays,
    playsToday: plays,
    playsLeft: Math.max(0, effectiveMaxPlays - plays),
    vacationMode: vacation
  };
}

module.exports = { playRasca, playTraga, playChave, getTrivialQuestions, submitTrivial, getStatus };
