const { db } = require('../db/database');
const { sendPushToAll } = require('./push');

// Crear tabla para registrar mensajes enviados y no repetirlos
db.prepare(`
  CREATE TABLE IF NOT EXISTS daily_sent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_index INTEGER NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now'))
  )
`).run();

const DAILY_MESSAGES_CATALOG = [
  // 👑 CATEGORÍA: EL RETO DE LOS 5 (PASAPORTE DE VERANO)
  {
    category: 'reto5',
    title: '👑 ¿Llevas tu Reto de los 5 a medias?',
    body: '¡Buenos días! No dejes tu pasaporte a medias. Completa tus 5 visitas a la terraza este verano y asegura tu NFT Furancho Legend para septiembre.'
  },
  {
    category: 'reto5',
    title: '📍 ¡Sumando sellos para el NFT Legend!',
    body: 'Recuerda que cada visita a la terraza en verano suma un sello a tu Reto de los 5. ¡Consigue tus 5 sellos antes de abrir en septiembre!'
  },
  {
    category: 'reto5',
    title: '🍷 ¡Completa el Reto de los 5!',
    body: '¡Buenos días! Pásate a sellar tu visita por la terraza. 5 visitas = NFT Furancho Legend + ventajas exclusivas para el reencuentro de vuelta.'
  },

  // 🍷 CATEGORÍA 1: MUSEO DO FURANCHO / PREMIOS
  {
    category: 'museum',
    title: '🍷 ¡Revisa tu Museo do Furancho!',
    body: 'Buenos días. Pásate por tu Museo do Furancho en la app, que igual tienes algún premio, vale o NFT guardado esperando por ti.'
  },
  {
    category: 'museum',
    title: '🏆 ¡Premios pendientes por revisar!',
    body: '¡Atención furancheiro! Revisa tu zurrón en el Museo... hay recompensas y vales que podrías tener pendientes de reclamar.'
  },
  {
    category: 'museum',
    title: '🔑 ¿Tienes NFTs sin reclamar?',
    body: 'Entra a la app y echa un ojo al Museo do Furancho. ¡No dejes tus logros y pases de temporada sin activar!'
  },
  {
    category: 'museum',
    title: '🎁 ¡Tus recompensas en el Furancho!',
    body: 'Recuerda que tus Corchos y premios te esperan en el Museo. ¡Revisa tu saldo y catálogo antes de que acabe el verano!'
  },
  {
    category: 'museum',
    title: '📜 ¡Revisa tu historial de logros!',
    body: '¿Has comprobado si tienes coleccionables o vales en tu perfil? Entra al Museo do Furancho y descúbrelo.'
  },
  {
    category: 'museum',
    title: '🍷 ¡Salud e tesouros no Museo!',
    body: '¡Buenos días! Tu Museo do Furancho guarda todas tus hazañas. Pásate a comprobar si tienes alguna copa o premio pendiente.'
  },
  {
    category: 'museum',
    title: '🪙 ¡Tus Corchos y Premios te esperan!',
    body: 'Pásate por el Museo do Furancho y comprueba tus insignias y pases VIP. ¡Que no se te quede nada por reclamar!'
  },
  {
    category: 'museum',
    title: '🎟️ ¿Miraste tu buzón de vales?',
    body: 'Abre la app y revisa tu sección de premios en el Museo do Furancho. ¡Asegúrate de tener todo listo para la reapertura!'
  },

  // ☀️ CATEGORÍA 2: DÍA DE PLAYA & VERANO
  {
    category: 'beach',
    title: '☀️ ¡Menudo día de playa hace hoy!',
    body: '¡Buenos días! Hace un día impresionante para ir a la playa... Disfruta del sol, la brisa marina y el verano gallego.'
  },
  {
    category: 'beach',
    title: '🌊 ¡Toalla, crema y sombra fresca!',
    body: 'Un día perfecto de playa antes de retomar las noches de viño y tapas. ¡Aprovecha el sol de la ría!'
  },
  {
    category: 'beach',
    title: '☀️ ¡El verano vuela, furancheiro!',
    body: 'Buenos días. Hoy toca día de costa, brisa y buena mesa. ¡Disfruta del sol gallego al máximo!'
  },
  {
    category: 'beach',
    title: '🏖️ ¡Sol, ría y boa xente!',
    body: 'Hace una mañana espectacular para escaparse a la playa. Disfruta del día con la familia y los amigos.'
  },
  {
    category: 'beach',
    title: '🌊 ¡Día de terraza y brisa marina!',
    body: '¡Buenos días! El sol aprieta y las rías están impresionantes. ¡A disfrutar del verano como se merece!'
  },
  {
    category: 'beach',
    title: '☀️ ¡Un día radiante de verano!',
    body: 'Ponte las gafas de sol y busca una buena playa. El verano es corto y en Galicia se disfruta cada minuto.'
  },
  {
    category: 'beach',
    title: '🏖️ ¡Brindis al sol de agosto!',
    body: 'Buenos días. Día de arena, mar y descanso. ¡Aprovecha el día de playa que luego la noche refresca!'
  },
  {
    category: 'beach',
    title: '🌊 ¡Rías Baixas en su esplendor!',
    body: '¡Menudo día azul hace hoy! Disfruta del paisaje, del agua y del verano en nuestra tierra.'
  },

  // ⏳ CATEGORÍA 3: CUENTA REGRESIVA A SEPTIEMBRE
  {
    category: 'reopening',
    title: '⏳ ¡Cada día más cerca de abrir!',
    body: '¡Buenos días! Falta muy poco para saber la fecha oficial de apertura. En septiembre volvemos con ideas nuevas y muchas ganas.'
  },
  {
    category: 'reopening',
    title: '🍷 ¡Septiembre se acerca!',
    body: 'El verano avanza y entre bambalinas seguimos preparando la reapertura del Furancho. ¡Se vienen noches inolvidables!'
  },
  {
    category: 'reopening',
    title: '⏳ ¡Descontando días para el reencuentro!',
    body: 'Falta menos para volver a reunirnos alrededor del viño nuevo, la broa y el raxo. ¡Septiembre está a la vuelta de la esquina!'
  },

  {
    category: 'reopening',
    title: '🍷 ¡Sorpresas en camino para la apertura!',
    body: 'Buenos días. Estamos afinando los detalles para septiembre. ¡La noche de reapertura va a ser histórica!'
  },
  {
    category: 'reopening',
    title: '⏳ ¡Preparando los barriles para septiembre!',
    body: '¡Buenos días! Cada día cuenta en nuestra cuenta regresiva. Muy pronto anunciaremos la fecha exacta de apertura.'
  },
  {
    category: 'reopening',
    title: '🍷 ¡Las noches de furancho volverán pronto!',
    body: 'Septiembre ya asoma en el calendario. Mantente atento a la app para ser el primero en conocer la fecha de apertura.'
  },
  {
    category: 'reopening',
    title: '⏳ ¡Cuenta atrás en marcha!',
    body: '¡Buenos días! La bodega se está preparando para volver a abrir sus puertas en septiembre. ¡Nos vemos muy pronto!'
  },
  {
    category: 'reopening',
    title: '🍷 ¡Ganas de furancho y boa xente!',
    body: 'Falta muy poco para desvelar la fecha de inicio de temporada. ¡Prepara tus cuncas que en septiembre volvemos!'
  },

  // 🥖 CATEGORÍA 4: REFRANES GASTRONÓMICOS GALLEGOS (EN CASTELLANO)
  {
    category: 'proverb',
    title: '🥖 Refrán Furancheiro del día',
    body: '"Con pan y vino se anda el camino" (Como decimos por aquí: con buena broa y buen vino no hay cuesta arriba). ¡Que tengas un gran día!'
  },
  {
    category: 'proverb',
    title: '🍷 Refrán Furancheiro del día',
    body: '"El agua para los bueyes y el vino para los hombres" (O agua para los peces y el viño para los furancheiros). ¡A disfrutar de la jornada!'
  },
  {
    category: 'proverb',
    title: '🐖 Refrán Furancheiro del día',
    body: '"Del cerdo hasta los andares" (En el furancho no se tira nada: zorza, raxo y boa xente). ¡Feliz día!'
  },
  {
    category: 'proverb',
    title: '🍇 Refrán Furancheiro del día',
    body: '"Por San Martino se prueba el vino y se mata el porquiño" (A cada santo su fiesta y a cada furancho su copa). ¡Buen día!'
  },
  {
    category: 'proverb',
    title: '🐙 Refrán Furancheiro del día',
    body: '"Donde hay pulpo y buen vino, sobra cualquier destino" (Buen apetito, buena compañía y cunca llena). ¡Feliz jornada!'
  },
  {
    category: 'proverb',
    title: '🔥 Refrán Furancheiro del día',
    body: '"Cunca de vino en mano no teme al invierno ni al verano" (El vino nuevo reconforta el cuerpo y alegra la mente). ¡A disfrutar!'
  },
  {
    category: 'proverb',
    title: '🥖 Refrán Furancheiro del día',
    body: '"A pan de quince días, hambre de tres semanas" (Con buena compaña y broa de millo todo sabe mejor). ¡Pasa un gran día!'
  },
  {
    category: 'proverb',
    title: '🍷 Refrán Furancheiro del día',
    body: '"Vino que alegre el corazón y llene la cunca con razón" (Que no falte la alegría ni la buena mesa). ¡Que tengas un día estupendo!'
  }
];

function sendDailyMorningMessage() {
  try {
    // Obtener los índices de los mensajes enviados en los últimos 30 días
    const recentRows = db.prepare(`
      SELECT msg_index FROM daily_sent_messages 
      WHERE sent_at >= datetime('now', '-30 days')
    `).all();
    
    const recentIndices = new Set(recentRows.map(r => r.msg_index));
    
    // Filtrar candidatos no enviados recientemente
    let candidates = DAILY_MESSAGES_CATALOG
      .map((item, idx) => ({ ...item, idx }))
      .filter(item => !recentIndices.has(item.idx));

    // Si ya se enviaron todos los del catálogo, reiniciar candidates
    if (!candidates.length) {
      candidates = DAILY_MESSAGES_CATALOG.map((item, idx) => ({ ...item, idx }));
    }

    // Elegir aleatoriamente uno de los candidatos
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];

    // Registrar en BD
    db.prepare(`
      INSERT INTO daily_sent_messages (msg_index, category, title, body)
      VALUES (?, ?, ?, ?)
    `).run(chosen.idx, chosen.category, chosen.title, chosen.body);

    // 1. Difusión por Web Push a todos los clientes suscritos
    sendPushToAll(chosen.title, chosen.body, { url: '/claim' }).catch(console.error);

    // 2. Inyectar en el Muro do Furancho
    try {
      const { injectSystemMuroMessage } = require('../db/database');
      injectSystemMuroMessage(`${chosen.title} — ${chosen.body}`);
    } catch (_) {}

    console.log(`[DailyMessage] ☀️ Mensaje de las 09:00 AM enviado con éxito (${chosen.category}): "${chosen.title}"`);
    return chosen;
  } catch (e) {
    console.error('[DailyMessage] Error enviando mensaje automático de la mañana:', e);
    return null;
  }
}

module.exports = {
  DAILY_MESSAGES_CATALOG,
  sendDailyMorningMessage
};
