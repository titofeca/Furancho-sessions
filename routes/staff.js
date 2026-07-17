// Acceso ligero para CAMAREROS — página /staff. Permite que cualquier camarero
// que trabaje esa noche, desde su propio móvil, escanee el "ID Socio (QR)" de un
// cliente y le fiche la ENTRADA para que participe en los sorteos. AISLADO del panel
// admin: el código de camarero solo desbloquea el check-in, nunca da acceso admin.
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const router = express.Router();

// Código que comparten los camareros esa noche. El admin lo configura en Railway
// (STAFF_CODE) y lo ve/comparte desde el panel. Default solo para desarrollo.
const STAFF_CODE = process.env.STAFF_CODE || 'camareros';

// Generoso pero acotado: un camarero ficha en ráfaga al abrir el local.
const staffLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  message: { error: 'Demasiadas peticiones, espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Comparación en tiempo constante para no filtrar el código por timing.
function codeOk(code) {
  if (!code || typeof code !== 'string') return false;
  const a = Buffer.from(code);
  const b = Buffer.from(STAFF_CODE);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireStaff(req, res, next) {
  if (codeOk(req.headers['x-staff-code'])) return next();
  return res.status(401).json({ error: 'Código de camarero no válido' });
}

// POST /api/staff/login — valida el código para desbloquear la página en ese móvil.
router.post('/login', staffLimiter, (req, res) => {
  const { code } = req.body || {};
  if (!codeOk(code)) return res.status(401).json({ error: 'Código incorrecto, ho.' });
  res.json({ success: true });
});

// POST /api/staff/checkin — el camarero ficha la ENTRADA del cliente escaneado.
// Reusa EXACTAMENTE la misma lógica de fichaje que /entry y /admin-checkin.
// Durante la campaña "Reto de los 5" añade además la visita de campaña, validando
// que el QR se ha escaneado EN VIVO (campaignTs fresco) para evitar capturas.
router.post('/checkin', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress, campaignTs } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const { performCheckin } = require('./mint');
    const result = performCheckin(walletAddress, req.ip);

    // ── Campaña "Reto de los 5" ──────────────────────────────────────────────
    const campaign = require('../services/campaign');
    if (campaign.isCampaignActive()) {
      // Anti-captura: durante la campaña el QR debe llevar timestamp fresco. Sin él
      // (QR estático o captura), no se cuenta la visita de campaña.
      if (campaignTs === undefined || campaignTs === null || campaignTs === '') {
        result.campaign = { active: true, counted: false, error: 'qr_not_live' };
      } else if (!campaign.isQrFresh(campaignTs)) {
        result.campaign = { active: true, counted: false, error: 'qr_expired' };
      } else {
        result.campaign = campaign.recordVisit(walletAddress);
      }
    } else {
      result.campaign = null;
    }

    // ── Premios NFT pendientes de entrega presencial ────────────────────────
    // Si el cliente ganó un sorteo cuyo premio es un NFT (p.ej. Chave Dourada)
    // y aún no se le entregó, se lo mostramos al camarero junto con el resultado.
    // El camarero pulsa el botón "Otorgar NFT" para confirmarlo (endpoint aparte).
    try {
      const { getPendingNftPrizes } = require('../db/database');
      const achievements = require('../services/achievements');
      const rows = getPendingNftPrizes(walletAddress) || [];
      result.pendingNftPrizes = rows.map(r => {
        const a = achievements.getById(r.nft_achievement_id);
        return {
          source: r.source || 'raffle',   // 'raffle' | 'weekly'
          raffleId: r.raffleId || null,
          week: r.week || null,
          prize: r.prize,
          achievementId: r.nft_achievement_id,
          achievementName: a ? a.name : r.nft_achievement_id,
          achievementImage: a ? a.image : (r.prize_image || null)
        };
      });
    } catch (_) { result.pendingNftPrizes = []; }

    // ── Privilexio do Guardián (tapa do día ligada a NFT) ───────────────────
    // Si el cliente fichado tiene el privilexio activo y sin consumir hoy, el
    // camarero lo ve al fichar y puede consumirlo ahí mismo (botón en /staff).
    // Fuente única: computeDailyTapaStatus (la misma de la tarjeta del cliente).
    try {
      const { computeDailyTapaStatus } = require('./mint');
      const tapa = computeDailyTapaStatus(walletAddress);
      result.dailyTapa = tapa && tapa.visible ? tapa : null;
    } catch (_) { result.dailyTapa = null; }

    // ── Premios del cliente (bonos de sorteo) ───────────────────────────────
    // El camarero ve al fichar: bonos ACEPTADOS por canjear (el canje sigue
    // siendo SOLO desde la app del cliente — botón verde) y premios ganados
    // PENDIENTES de aceptar (que le dé a "¡ES MÍO!" antes de que caduque).
    try {
      const { db } = require('../db/database');
      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
      result.prizes = db.prepare(`
        SELECT id, prize, status, verification_code, establishment, validity_end_date, acceptance_deadline
        FROM raffles
        WHERE LOWER(winner_wallet) = LOWER(?)
          AND nft_achievement_id IS NULL
          AND (
            status = 'accepted'
            OR (status = 'pending_acceptance' AND acceptance_deadline > ?)
          )
        ORDER BY created_at DESC LIMIT 10
      `).all(walletAddress, nowStr).map(r => ({
        raffleId: r.id,
        prize: r.prize,
        status: r.status,
        code: r.status === 'accepted' ? r.verification_code : null,
        establishment: r.establishment || null,
        validityEndDate: r.validity_end_date || null
      }));
    } catch (_) { result.prizes = []; }

    return res.json(result);
  } catch (e) {
    console.error('Error en /staff/checkin:', e.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/staff/claim-daily-tapa — el camarero consume el privilexio del cliente
// al entregarle la tapa/cunca. Misma fuente única y anti-doble-canje que el admin:
// 1 por wallet y 1 por NFT+serie al día. Body: { walletAddress, nftType, nftId, serial }.
router.post('/claim-daily-tapa', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress, nftType, nftId, serial } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const { registerDailyTapaClaim } = require('../db/database');
    registerDailyTapaClaim({ walletAddress, nftType, nftId, serial, staffUser: 'staff' });
    res.json({ success: true, message: 'Privilexio consumido — tapa e cunca entregadas.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mensajes de error comunes al otorgar un NFT (sorteo normal o chave semanal).
const GRANT_ERROR_MESSAGES = {
  raffle_not_found: 'Sorteo no encontrado',
  not_an_nft_prize: 'Ese sorteo no es de premio NFT',
  already_granted: 'Este NFT ya fue entregado antes',
  wallet_mismatch: 'Esa wallet no es la ganadora del sorteo',
  achievement_not_found: 'El logro NFT del sorteo no existe'
};

// POST /api/staff/grant-nft-prize — el camarero entrega en persona el NFT al ganador.
// Body: { walletAddress, source:'raffle'|'weekly', raffleId?, week? }.
// Crea achievement_mints con pending_approval (el admin lo confirma antes de mintear).
// Idempotente. Soporta tanto sorteos normales (raffleId) como la Chave Semanal (week).
router.post('/grant-nft-prize', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress, source, raffleId, week } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const { grantNftPrize, grantWeeklyNftPrize } = require('../db/database');
    let result;
    if (source === 'honor') {
      const { claimAchievement, getAchievementMint } = require('../db/database');
      const achievements = require('../services/achievements');
      const honor = achievements.getById('furancheiro_honor');
      if (!honor) return res.status(400).json({ error: 'Logro de honor no configurado' });
      if (!achievements.walletUnlocked(walletAddress, honor)) {
        return res.status(400).json({ error: 'El cliente no califica para este logro (requiere 2 reservas VIP confirmadas)' });
      }
      const existing = getAchievementMint(walletAddress, honor.id);
      if (!existing || existing.status === 'failed') {
        claimAchievement(walletAddress, honor.id, honor.tokenId, 'pending_approval');
      }
      result = { ok: true, achievement: honor };
    } else if (source === 'weekly') {
      if (!week) return res.status(400).json({ error: 'Falta la semana del sorteo' });
      result = grantWeeklyNftPrize(week, walletAddress, 'staff');
    } else {
      const rid = parseInt(raffleId);
      if (!rid) return res.status(400).json({ error: 'ID de sorteo no válido' });
      result = grantNftPrize(rid, walletAddress, 'staff');
    }
    if (!result.ok) {
      return res.status(400).json({ error: GRANT_ERROR_MESSAGES[result.error] || result.error });
    }
    res.json({ success: true, achievement: result.achievement });
  } catch (e) {
    console.error('Error en /staff/grant-nft-prize:', e.message);
    res.status(500).json({ error: 'Error otorgando NFT' });
  }
});

// Compat: la ruta antigua con :raffleId sigue funcionando para sorteos normales.
router.post('/grant-nft-prize/:raffleId', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress } = req.body || {};
  const raffleId = parseInt(req.params.raffleId);
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  if (!raffleId) return res.status(400).json({ error: 'ID de sorteo no válido' });
  try {
    const { grantNftPrize } = require('../db/database');
    const result = grantNftPrize(raffleId, walletAddress, 'staff');
    if (!result.ok) {
      return res.status(400).json({ error: GRANT_ERROR_MESSAGES[result.error] || result.error });
    }
    res.json({ success: true, achievement: result.achievement });
  } catch (e) {
    console.error('Error en /staff/grant-nft-prize:', e.message);
    res.status(500).json({ error: 'Error otorgando NFT' });
  }
});

// GET /api/staff/campaign/leaderboard — ranking de la campaña para la pantalla del
// camarero (top clientes por visitas + cuántos completaron el reto).
router.get('/campaign/leaderboard', requireStaff, (req, res) => {
  try {
    const campaign = require('../services/campaign');
    res.json({
      active: campaign.isCampaignActive(),
      leaderboard: campaign.getLeaderboard(10),
      stats: campaign.getStats()
    });
  } catch (e) {
    console.error('Error en /staff/campaign/leaderboard:', e.message);
    res.status(500).json({ error: 'Error cargando ranking' });
  }
});

// ── HORARIO DE LA TERRAZA ────────────────────────────────────────────────────
// Los camareros pueden ver y ACTUALIZAR el horario semanal desde su página, para
// que no dependa del admin. Solo toca app_settings: aislado de fichajes/sorteos.

// GET /api/staff/terraza-hours — horario actual (para el editor del camarero)
router.get('/terraza-hours', requireStaff, (req, res) => {
  try {
    res.json(require('../services/terraza').getTerrazaHours());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/staff/terraza-hours — guardar horario editado por un camarero
router.post('/terraza-hours', staffLimiter, requireStaff, (req, res) => {
  try {
    const saved = require('../services/terraza').saveTerrazaHours(
      { days: req.body.days, overrides: req.body.overrides, note: req.body.note }, 'staff'
    );
    res.json({ success: true, ...saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
