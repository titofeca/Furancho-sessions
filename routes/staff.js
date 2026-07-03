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
          raffleId: r.id,
          prize: r.prize,
          achievementId: r.nft_achievement_id,
          achievementName: a ? a.name : r.nft_achievement_id,
          achievementImage: a ? a.image : (r.prize_image || null)
        };
      });
    } catch (_) { result.pendingNftPrizes = []; }

    return res.json(result);
  } catch (e) {
    console.error('Error en /staff/checkin:', e.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/staff/grant-nft-prize/:raffleId — el camarero entrega en persona el NFT
// al ganador del sorteo. Crea achievement_mints con pending_approval (el admin lo
// confirma antes de mintear on-chain). Idempotente: si ya se otorgó, error.
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
      const messages = {
        raffle_not_found: 'Sorteo no encontrado',
        not_an_nft_prize: 'Ese sorteo no es de premio NFT',
        already_granted: 'Este NFT ya fue entregado antes',
        wallet_mismatch: 'Esa wallet no es la ganadora del sorteo',
        achievement_not_found: 'El logro NFT del sorteo no existe'
      };
      return res.status(400).json({ error: messages[result.error] || result.error });
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

module.exports = router;
