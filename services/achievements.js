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
  },
  {
    // "Reto de los 5" — campaña de fidelización de verano (22 jul – 20 sep 2026).
    // Se desbloquea al acumular 5 visitas de campaña (tabla campaign_visits). El cliente
    // lo reclama desde su museo, pero el mint queda 'pending_approval' hasta que admin lo
    // confirme (evita gas por trampas). Ver services/campaign.js.
    // TODO: sustituir 'furanchotorre.jpg' por la imagen definitiva de "Furancho Legend 2026".
    id: 'furancho_legend_2026',
    name: 'Furancho Legend 2026',
    description: 'Leyenda del Furancho · Verano 2026. NFT exclusivo por completar el Reto de los 5: cinco visitas durante la temporada de verano.',
    image: 'furanchotorre.jpg',
    tokenId: 103,
    edition: 'Verano 2026',
    rule: { type: 'campaign_visits', campaignId: 'reto_5_verano_2026', requiredVisits: 5 }
  },
  {
    id: 'furancheiro_honor',
    name: 'Furancheiro de Honor',
    description: 'Miembro de Honor do Furancho. NFT exclusivo por reservar mesa VIP en la app 2 veces y asistir a las sesiones.',
    image: 'furancheiro_honor.jpg',
    tokenId: 104,
    edition: 'Miembro de Honor (Max 25)',
    rule: { type: 'vip_bookings', requiredCount: 2 },
    maxSupply: 25
  },
  {
    id: 'guardian_furancho',
    name: 'Guardián del Furancho',
    description: 'Guardián Oficial do Furancho. NFT exclusivo para los protectores de la cunca y el barril.',
    image: 'nft_guardian_furancho.jpg',
    tokenId: 105,
    edition: 'Limitada (Max 25)',
    rule: { type: 'raffle_only' },
    maxSupply: 25
  },
  {
    id: 'meme_vip',
    name: 'Meme VIP',
    description: 'Edición Limitada. Meme oficial VIP para experiencias exclusivas de hotel y mucho más.',
    image: 'nft_meme_vip.jpg',
    tokenId: 50,
    edition: 'Limitada (Max 50)',
    rule: { type: 'raffle_only' }, // No autodesbloqueable, solo admin/staff lo otorga
    maxSupply: 50
  }
  // Imágenes ya subidas, pendientes de su regla (día de asistencia):
  // { id:'maria_pita', name:'…', image:'furanchomariapita.jpg', tokenId:101, rule:{ type:'visit_on_date', date:'YYYY-MM-DD' } }
];

// Normaliza la imagen a una ruta pública que empieza por "/". Los logros del código
// guardan el nombre pelado (sirve desde /assets/); los creados desde el panel guardan
// una ruta completa ("/prize-images/xxx.png"), que se usa tal cual.
function _normImage(img) {
  if (!img) return '';
  return String(img).startsWith('/') ? String(img) : `/assets/${img}`;
}

// Logros creados desde el panel (tabla custom_achievements). Se mapean a la MISMA
// forma que los del código para que todo lo demás funcione igual.
function _customList() {
  try {
    return db.prepare(`SELECT id, name, description, image, token_id AS tokenId, edition, rule_type, rule_date
                       FROM custom_achievements ORDER BY token_id ASC`).all()
      .map(r => {
        let rule = null;
        if (r.rule_type === 'visit_on_date') {
          rule = { type: 'visit_on_date', date: r.rule_date };
        } else if (r.rule_type === 'campaign_visits') {
          rule = { type: 'campaign_visits', campaignId: 'reto_5_verano_2026', requiredVisits: parseInt(r.rule_date || '5') };
        } else if (r.rule_type === 'vip_bookings') {
          rule = { type: 'vip_bookings', requiredCount: parseInt(r.rule_date || '2') };
        } else if (r.rule_type === 'raffle_only') {
          rule = { type: 'raffle_only' };
        }
        return {
          id: r.id, name: r.name, description: r.description, image: _normImage(r.image),
          tokenId: r.tokenId, edition: r.edition,
          rule,
          custom: true
        };
      });
  } catch (_) { return []; }
}

// Overrides puntuales (tabla achievement_overrides): permiten sustituir la imagen de
// un logro hardcodeado desde el panel sin tocar código (p.ej. NFT Furancho Legend).
function _overrides() {
  try { return require('../db/database').getAllAchievementOverrides(); } catch (_) { return {}; }
}

// Catálogo COMPLETO = logros del código + los creados desde el panel. Aplica overrides.
function list() {
  const dbList = _customList();
  const dbMap = {};
  dbList.forEach(a => { dbMap[a.id] = a; });

  const ov = _overrides();

  const codeList = ACHIEVEMENTS.map(a => {
    const imageNorm = _normImage(a.image);
    let finalAch = { ...a, image: imageNorm, custom: false };
    if (ov[a.id]) finalAch.image = ov[a.id];

    // Si está en la base de datos (se ha editado), sobreescribimos
    if (dbMap[a.id]) {
      const dbVal = dbMap[a.id];
      finalAch = {
        ...finalAch,
        name: dbVal.name,
        description: dbVal.description,
        image: dbVal.image || finalAch.image,
        edition: dbVal.edition,
        rule: dbVal.rule,
        custom: false // conserva custom=false para no permitir borrarlo
      };
    }
    return finalAch;
  });

  const codeIds = new Set(ACHIEVEMENTS.map(a => a.id));
  const onlyCustom = dbList.filter(a => !codeIds.has(a.id)).map(a => ({ ...a, custom: true }));

  return codeList.concat(onlyCustom);
}

function getById(id) {
  return list().find(a => a.id === id);
}

function getByTokenId(tokenId) {
  return list().find(a => Number(a.tokenId) === Number(tokenId));
}

// Siguiente token libre para un logro nuevo (≥ 100).
function nextTokenId() {
  const used = list().map(a => Number(a.tokenId)).filter(n => !isNaN(n));
  return Math.max(100, ...used) + 1;
}

// Crea un logro desde el panel. Valida y devuelve el logro creado. NO mintea nada:
// solo define el logro; el minteo on-chain ocurre cuando un cliente lo reclama (visit_on_date)
// o cuando el staff se lo entrega en persona (raffle_only).
function createCustom({ id, name, description, image, edition, ruleDate, tokenId, ruleType }) {
  const slug = String(id || name || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('Falta el nombre del logro');
  if (!name || !String(name).trim()) throw new Error('Falta el nombre del logro');
  const rt = ruleType || 'visit_on_date';
  if (rt === 'visit_on_date') {
    if (!ruleDate || !/^\d{4}-\d{2}-\d{2}$/.test(ruleDate)) throw new Error('Falta la fecha de desbloqueo (YYYY-MM-DD)');
  }
  if (getById(slug)) throw new Error('Ya existe un logro con ese nombre/id');
  const tid = tokenId ? parseInt(tokenId) : nextTokenId();
  if (getByTokenId(tid)) throw new Error(`El token ${tid} ya está en uso`);
  db.prepare(`INSERT INTO custom_achievements (id, name, description, image, token_id, edition, rule_type, rule_date)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, String(name).trim(), description || null, image || null, tid, edition || null, rt, ruleDate || null);
  return getById(slug);
}

// Devuelve solo los logros que se otorgan como premio de sorteo. Útil para el
// desplegable "Premio NFT" al programar sorteos.
function listRaffleOnly() {
  return list().filter(a => a.rule && a.rule.type === 'raffle_only');
}

// Edita un logro creado desde el panel (y soporta inicializar los del código).
// El token_id NO se toca (es la identidad on-chain del NFT).
function updateCustom(id, { name, description, image, edition, ruleType, ruleDate }) {
  let existing = db.prepare(`SELECT * FROM custom_achievements WHERE id = ?`).get(id);
  if (!existing) {
    const codeAch = ACHIEVEMENTS.find(a => a.id === id);
    if (!codeAch) {
      throw new Error('Logro no encontrado');
    }
    const rule_type = codeAch.rule ? codeAch.rule.type : 'visit_on_date';
    let rule_date = null;
    if (rule_type === 'visit_on_date') {
      rule_date = codeAch.rule.date;
    } else if (rule_type === 'campaign_visits') {
      rule_date = String(codeAch.rule.requiredVisits || 5);
    } else if (rule_type === 'vip_bookings') {
      rule_date = String(codeAch.rule.requiredCount || 2);
    }
    const conflict = db.prepare(`SELECT id FROM custom_achievements WHERE token_id = ? AND id != ?`).get(codeAch.tokenId, codeAch.id);
    if (conflict) {
      db.prepare(`UPDATE custom_achievements SET token_id = ? WHERE id = ?`).run(nextTokenId(), conflict.id);
    }
    db.prepare(`INSERT OR IGNORE INTO custom_achievements (id, name, description, image, token_id, edition, rule_type, rule_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(codeAch.id, codeAch.name, codeAch.description, codeAch.image, codeAch.tokenId, codeAch.edition || null, rule_type, rule_date);
    existing = db.prepare(`SELECT * FROM custom_achievements WHERE id = ?`).get(id);
  }

  const fields = [], vals = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw new Error('El nombre no puede quedar vacío');
    fields.push('name = ?'); vals.push(String(name).trim());
  }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description || null); }
  if (image !== undefined && image) { fields.push('image = ?'); vals.push(image); }
  if (edition !== undefined) { fields.push('edition = ?'); vals.push(edition || null); }
  
  const nextRuleType = ruleType !== undefined ? ruleType : existing.rule_type;
  if (ruleType !== undefined) { fields.push('rule_type = ?'); vals.push(nextRuleType); }
  if (nextRuleType === 'visit_on_date') {
    const effectiveDate = ruleDate !== undefined ? ruleDate : existing.rule_date;
    if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      throw new Error('El desbloqueo por asistencia necesita una fecha (YYYY-MM-DD)');
    }
    if (ruleDate !== undefined) { fields.push('rule_date = ?'); vals.push(ruleDate); }
  } else {
    if (ruleDate !== undefined) { fields.push('rule_date = ?'); vals.push(ruleDate || null); }
  }

  if (!fields.length) return getById(id);
  vals.push(id);
  db.prepare(`UPDATE custom_achievements SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getById(id);
}

// Borra un logro creado desde el panel (nunca los del código). Devuelve true si borró.
function deleteCustom(id) {
  const hardcoded = ACHIEVEMENTS.some(a => a.id === id);
  if (hardcoded) throw new Error('Ese logro está definido en el código y no se puede borrar desde aquí');
  const res = db.prepare(`DELETE FROM custom_achievements WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Verificación servidor de la regla de desbloqueo. Hoy: asistencia (visita contada) a
// una fecha concreta. Devuelve true/false.
function walletMeetsRule(wallet, rule) {
  if (!wallet || !rule) return false;
  // Logros que solo se otorgan como premio de sorteo (chave dourada, etc.):
  // NUNCA se autodesbloquean desde el museo. Solo el staff los entrega en persona
  // vía escáner + botón "Otorgar NFT".
  if (rule.type === 'raffle_only') return false;
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
  if (rule.type === 'campaign_visits') {
    // Desbloqueo por acumular N visitas de campaña (tabla campaign_visits, independiente
    // del fichaje normal). Se verifica en servidor: nunca se fía del cliente.
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM campaign_visits
      WHERE LOWER(wallet_address) = LOWER(?) AND campaign_id = ?
    `).get(wallet, rule.campaignId || 'reto_5_verano_2026');
    return (row ? row.c : 0) >= (rule.requiredVisits || 5);
  }
  if (rule.type === 'vip_bookings') {
    // Desbloqueo por acumular N reservas VIP confirmadas
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM vip_reservations
      WHERE LOWER(wallet_address) = LOWER(?) AND status = 'confirmed'
    `).get(wallet);
    return (row ? row.c : 0) >= (rule.requiredCount || 2);
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
    image: `${APP_URL}${a.image}`,   // a.image ya viene normalizada ("/assets/..." o "/prize-images/...")
    external_url: APP_URL,
    attributes: [
      { trait_type: 'Tipo', value: 'Logro' },
      { trait_type: 'Edición', value: a.edition || 'Furancho Sessions' },
      { trait_type: 'Blockchain', value: 'Polygon' }
    ]
  };
}

// Cuántas wallets DISTINTAS tienen cada logro NFT especial (para el panel admin).
// minted = ya en wallet (status success) · pending = en cola de minteo · total = no fallidos.
function getAchievementStats() {
  const rows = db.prepare(`
    SELECT achievement_id,
      COUNT(DISTINCT CASE WHEN status = 'success' THEN LOWER(wallet_address) END) AS minted,
      COUNT(DISTINCT CASE WHEN status = 'pending' THEN LOWER(wallet_address) END) AS pending,
      COUNT(DISTINCT CASE WHEN status != 'failed' THEN LOWER(wallet_address) END) AS total
    FROM achievement_mints GROUP BY achievement_id
  `).all();
  const byId = {};
  rows.forEach(r => { byId[r.achievement_id] = r; });
  return _all().map(a => {
    const s = byId[a.id] || {};
    return {
      id: a.id, name: a.name, edition: a.edition || null, tokenId: a.tokenId, custom: !!a.custom,
      minted: s.minted || 0, pending: s.pending || 0, total: s.total || 0
    };
  });
}

module.exports = {
  list, getById, getByTokenId, nextTokenId,
  walletMeetsRule, walletUnlocked, metadataForToken,
  getAchievementStats, createCustom, updateCustom, deleteCustom, listRaffleOnly,
  ACHIEVEMENTS
};
