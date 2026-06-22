// ─────────────────────────────────────────────────────────────────────────────
//  CATÁLOGO ÚNICO DE LOGROS NFT (ediciones especiales por asistencia a un día/evento).
//
//  Distinto de las insignias emoji del museo: estos son NFT reales, cada uno con su
//  token propio en el mismo contrato ERC-1155 que los niveles. El cliente los reclama
//  desde su museo. Token IDs >= 100 para NO colisionar con los niveles (1-4).
//
//  La condición de desbloqueo se verifica SIEMPRE en el servidor (no se fía del
//  cliente): hay que haber asistido (visita contada) al día del evento.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require('../db/database');
const APP_URL = process.env.APP_URL || 'https://furancho-sessions-production.up.railway.app';

// Mismo desfase horario que usa el resto del sistema para fechar visitas (Madrid verano).
const VISIT_TZ = "'+2 hours'";

const ACHIEVEMENTS = [
  {
    id: 'furancheiro_fiesteiro',
    name: 'Furancheiro Fiesteiro',
    description: 'San Xoán 2026 · A Coruña. Edición especial NFT por asistir a la sesión post-San Xoán do Furancho.',
    image: 'furanchosanjuan.jpg',
    tokenId: 100,
    edition: 'San Xoán 2026',
    rule: { type: 'visit_on_date', date: '2026-06-25' }
  }
  // Imágenes ya subidas, pendientes de su regla (día de asistencia):
  // { id:'maria_pita', name:'…', image:'furanchomariapita.jpg', tokenId:101, rule:{ type:'visit_on_date', date:'YYYY-MM-DD' } }
  // { id:'torre',      name:'…', image:'furanchotorre.jpg',      tokenId:102, rule:{ type:'visit_on_date', date:'YYYY-MM-DD' } }
];

const _byId = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
const _byToken = Object.fromEntries(ACHIEVEMENTS.map(a => [a.tokenId, a]));

function list() { return ACHIEVEMENTS; }
function getById(id) { return _byId[id] || null; }
function getByTokenId(tokenId) { return _byToken[tokenId] || null; }

// Verificación servidor de la regla de desbloqueo. Hoy: asistencia (visita contada) a
// una fecha concreta. Devuelve true/false.
function walletMeetsRule(wallet, rule) {
  if (!wallet || !rule) return false;
  if (rule.type === 'visit_on_date') {
    const row = db.prepare(`
      SELECT 1 FROM (
        SELECT date(entry_time, ${VISIT_TZ}) AS d FROM sessions
          WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
        UNION
        SELECT date(visited_at) AS d FROM visits
          WHERE LOWER(wallet_address) = LOWER(?)
      ) WHERE d = ? LIMIT 1
    `).get(wallet, wallet, rule.date);
    return !!row;
  }
  return false;
}

function walletUnlocked(wallet, achievement) {
  return walletMeetsRule(wallet, achievement.rule);
}

// Metadatos ERC-1155 del token de un logro (los sirve /nft-metadata/:id a marketplaces).
function metadataForToken(tokenId) {
  const a = getByTokenId(tokenId);
  if (!a) return null;
  return {
    name: a.name,
    description: a.description,
    image: `${APP_URL}/assets/${a.image}`,
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Tipo', value: 'Logro' },
      { trait_type: 'Edición', value: a.edition || 'Furancho Sessions' },
      { trait_type: 'Blockchain', value: 'Polygon' }
    ]
  };
}

module.exports = {
  list, getById, getByTokenId,
  walletMeetsRule, walletUnlocked, metadataForToken,
  ACHIEVEMENTS
};
