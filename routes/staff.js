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
    // Regla (anti-captura incluida) en services/campaign.js: la misma que aplica el
    // Escáner del panel, para que fichar por camarero o por admin cuente igual.
    const campaign = require('../services/campaign');
    result.campaign = campaign.recordVisitFromScan(walletAddress, campaignTs);

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

    // ── Reserva VIP de HOY ──────────────────────────────────────────────────
    // Si el cliente fichado tiene mesa reservada para el evento de hoy, el
    // camarero la ve al escanear (nombre de mesa, pax, estado) para poder
    // acompañarlo a su sitio — y confirmarla si sigue pendiente.
    try {
      const { db } = require('../db/database');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
      const vip = db.prepare(`
        SELECT vr.id, vr.status, vr.group_size, vr.alias, vr.notes, e.title, e.event_date
        FROM vip_reservations vr JOIN events e ON e.id = vr.event_id
        WHERE LOWER(vr.wallet_address) = LOWER(?) AND e.event_date = ? AND vr.status != 'cancelled'
        LIMIT 1
      `).get(walletAddress, today);
      result.vipToday = vip ? {
        id: vip.id,
        status: vip.status,
        groupSize: vip.group_size,
        alias: vip.alias || null,
        notes: vip.notes || null,
        eventTitle: vip.title
      } : null;
    } catch (_) { result.vipToday = null; }

    // ── Lo que le debe el meme ──────────────────────────────────────────────
    // Si compró el meme y aún le quedan tapas, viño o la camiseta por recibir,
    // el camarero lo ve al fichar y se lo entrega ahí mismo. Fuente única:
    // services/memeShop.js (las mismas cuentas que ve el cliente y el panel).
    try {
      const shop = require('../services/memeShop');
      result.memePerks = shop.entitlementsOfWallet(walletAddress)
        .filter(e => e.qty_used < e.qty_total)
        .map(e => ({
          id: e.id, emoji: e.emoji, label: e.label, kind: e.kind,
          left: e.qty_total - e.qty_used, total: e.qty_total, serial: e.serial
        }));
    } catch (_) { result.memePerks = []; }

    // ── Banco do Corcho: compras y canjes pendientes de validar ─────────────
    // COMPRA: solicitudes de recarga en € que el socio pidió desde su móvil y aún
    // no ha pagado/validado — el camarero cobra en la barra y confirma (acredita
    // los $CORCHO). CANJE: vales de consumición pendientes de entregar. Fuente
    // única: db/database.js. Sin validar aquí, la compra acreditaría monedas gratis.
    try {
      const { getPendingCorchoPackRequests, getPendingRedemptions } = require('../db/database');
      result.corchoPacks = getPendingCorchoPackRequests(walletAddress).map(r => ({
        id: r.id, packName: r.pack_name, coins: r.coins, priceEur: r.price_eur
      }));
      result.corchoVouchers = getPendingRedemptions(walletAddress).map(v => ({
        code: v.code, itemName: v.item_name, itemEmoji: v.item_emoji, priceCorcho: v.price_corcho, expiresAt: v.expires_at
      }));
    } catch (_) { result.corchoPacks = []; result.corchoVouchers = []; }

    return res.json(result);
  } catch (e) {
    console.error('Error en /staff/checkin:', e.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/staff/campaign-checkin — el camarero registra UNA VISITA DE CAMPAÑA manualmente,
// sin necesitar que el cliente enseñe el QR en vivo. Autenticado con código de staff.
// Respeta: 1 visita/día, no cuenta días de Furancho, no interfiere con niveles.
router.post('/campaign-checkin', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const campaign = require('../services/campaign');
    if (!campaign.isCampaignActive()) {
      return res.json({ active: false, counted: false, message: 'La campaña no está activa.' });
    }
    const result = campaign.recordVisitByStaff(walletAddress);

    if (result.error === 'furancho_day') {
      return res.json({
        ...result,
        message: '⚠️ Hoy hay Furancho. Los días de sesión no suman visita al Reto de Verano. Correcto.'
      });
    }

    return res.json({
      ...result,
      message: result.counted
        ? `✅ Visita de campaña anotada. Total: ${result.totalVisits}/${result.required}.`
        : `ℹ️ Este cliente ya tenía visita de campaña hoy. Total: ${result.totalVisits}/${result.required}.`
    });
  } catch (e) {
    console.error('Error en /staff/campaign-checkin:', e.message);
    res.status(500).json({ error: 'Error registrando visita de campaña' });
  }
});


// ── RESERVAS VIP DE LA NOCHE ────────────────────────────────────────────────
// Los camareros ven las mesas reservadas del evento de HOY (nombre de mesa, pax,
// hora y estado) para recibir a los grupos y acompañarlos a su sitio. Sin teléfono:
// ese dato queda solo en el panel admin.

// GET /api/staff/reservations — reservas del evento de hoy
router.get('/reservations', requireStaff, (req, res) => {
  try {
    const { db, getVipReservations } = require('../db/database');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const event = db.prepare(`SELECT id, title, event_date FROM events WHERE event_date = ? AND active = 1`).get(today);
    if (!event) return res.json({ event: null, reservations: [] });
    const reservations = getVipReservations(event.id)
      .filter(r => r.status !== 'cancelled')
      .map(r => ({
        id: r.id,
        walletMasked: r.wallet_masked,
        groupSize: r.group_size,
        status: r.status,
        alias: r.alias || null,
        notes: r.notes || null
      }));
    res.json({ event: { id: event.id, title: event.title, date: event.event_date }, reservations });
  } catch (e) {
    console.error('Error en /staff/reservations:', e.message);
    res.status(500).json({ error: 'Error cargando reservas' });
  }
});

// POST /api/staff/vip/:id/confirm — el camarero confirma una reserva PENDIENTE.
// Solo pending → confirmed (cancelar sigue siendo cosa del admin). Reusa la misma
// fuente única que el admin: alias de mesa + mensaje en el tablón + push al cliente.
router.post('/vip/:id/confirm', staffLimiter, requireStaff, (req, res) => {
  try {
    const { getVipReservation, updateVipStatus, sendVipInboxNotification } = require('../db/database');
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Reserva no válida' });
    const reservation = getVipReservation(id);
    if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (reservation.status === 'confirmed') {
      return res.json({ success: true, alias: reservation.alias || null, already: true });
    }
    if (reservation.status !== 'pending') {
      return res.status(400).json({ error: 'Solo se pueden confirmar reservas pendientes' });
    }
    const alias = updateVipStatus(id, 'confirmed');
    try { sendVipInboxNotification(reservation.wallet_address, reservation.event_id, 'confirmed', alias); } catch (_) {}
    try {
      const { broadcast } = require('./raffle');
      broadcast('vip_status', { eventId: reservation.event_id, status: 'confirmed', eventTitle: reservation.event_title, alias }, reservation.wallet_address);
    } catch (_) {}
    try {
      const { sendPushToWallet } = require('../services/push');
      const aliasTxt = alias ? ` a nombre de "${alias}"` : '';
      sendPushToWallet(reservation.wallet_address, '⭐ ¡Reserva VIP Confirmada!',
        `Tu mesa VIP${aliasTxt} para "${reservation.event_title}" está confirmada. ¡Nos vemos allí, neno! 🥂`, { url: '/claim' });
    } catch (_) {}
    res.json({ success: true, alias: alias || null });
  } catch (e) {
    console.error('Error en /staff/vip/confirm:', e.message);
    res.status(500).json({ error: 'Error confirmando la reserva' });
  }
});

// Helper para obtener el nombre del camarero desde la cabecera
function getStaffName(req) {
  const raw = req.headers['x-staff-name'];
  if (!raw) return 'staff';
  try {
    return decodeURIComponent(raw).trim() || 'staff';
  } catch (_) {
    return 'staff';
  }
}

// POST /api/staff/claim-daily-tapa — el camarero consume el privilexio del cliente
// al entregarle la tapa/cunca. Misma fuente única y anti-doble-canje que el admin:
// 1 por wallet y 1 por NFT+serie al día. Body: { walletAddress, nftType, nftId, serial, sig }.
router.post('/claim-daily-tapa', staffLimiter, requireStaff, (req, res) => {
  const { walletAddress, nftType, nftId, serial, sig } = req.body || {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de wallet no válida' });
  }
  try {
    const { registerDailyTapaClaim } = require('../db/database');
    const staffName = getStaffName(req);
    registerDailyTapaClaim({ walletAddress, nftType, nftId, serial, sig, staffUser: staffName });
    res.json({ success: true, message: 'Privilexio consumido — tapa e cunca entregadas.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/staff/corcho-pack/:id/confirm — el camarero COBRA en la barra la
// recarga de $CORCHO y la confirma. Solo aquí se acreditan las monedas. Idempotente.
router.post('/corcho-pack/:id/confirm', staffLimiter, requireStaff, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Solicitud de compra no válida' });
  try {
    const { confirmCorchoPackRequest } = require('../db/database');
    const result = confirmCorchoPackRequest(id, getStaffName(req));
    if (!result.ok) {
      const msg = {
        not_found: 'Esa compra ya no existe',
        cancelled: 'Esa compra fue anulada',
        not_pending: 'Esa compra ya no está pendiente'
      }[result.error] || 'No se pudo confirmar la compra';
      return res.status(400).json({ error: msg });
    }
    res.json({
      success: true, already: !!result.already,
      coins: result.request ? result.request.coins : null,
      newBalance: result.newBalance,
      message: result.already ? 'Esta compra ya estaba confirmada.' : 'Pago confirmado — $CORCHO acreditados.'
    });
  } catch (e) {
    console.error('Error en /staff/corcho-pack/confirm:', e.message);
    res.status(500).json({ error: 'Error confirmando la compra' });
  }
});

// POST /api/staff/corcho-voucher/:code/validate — el camarero valida el vale de
// canje al entregar la consumición. Idempotente y anti-caducidad (los $CORCHO ya
// se descontaron al canjear; aquí solo se marca la entrega).
router.post('/corcho-voucher/:code/validate', staffLimiter, requireStaff, (req, res) => {
  const code = req.params.code;
  if (!code) return res.status(400).json({ error: 'Falta el código del vale' });
  try {
    const { validateRedemptionVoucher } = require('../db/database');
    const result = validateRedemptionVoucher(code, getStaffName(req));
    if (!result.ok) {
      const msg = {
        not_found: 'Ese vale no existe',
        cancelled: 'Ese vale fue anulado',
        expired: 'Ese vale caducó — pídele que lo genere de nuevo desde su app',
        not_pending: 'Ese vale ya no está pendiente'
      }[result.error] || 'No se pudo validar el vale';
      return res.status(400).json({ error: msg });
    }
    res.json({
      success: true, already: !!result.already,
      item: result.voucher ? `${result.voucher.item_emoji} ${result.voucher.item_name}` : null,
      message: result.already ? 'Este vale ya estaba validado.' : 'Vale validado — entrega la consumición.'
    });
  } catch (e) {
    console.error('Error en /staff/corcho-voucher/validate:', e.message);
    res.status(500).json({ error: 'Error validando el vale' });
  }
});

// POST /api/staff/meme-perk — el camarero entrega una unidad de lo que trae el
// meme (una tapa, la xarra, la camiseta cuando hay stock). Body: { entitlementId }.
// La misma función que usa el panel: no hay dos contabilidades.
router.post('/meme-perk', staffLimiter, requireStaff, (req, res) => {
  const { entitlementId } = req.body || {};
  const id = parseInt(entitlementId, 10);
  if (!id) return res.status(400).json({ error: 'Falta qué entregar' });
  try {
    const shop = require('../services/memeShop');
    const staffName = getStaffName(req);
    const e = shop.usePerk(id, 1, `Entregado por: ${staffName}`);
    res.json({ success: true, left: e.qty_total - e.qty_used, label: e.label });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mensajes de error comunes al otorgar un NFT (sorteo normal o chave semanal).
const GRANT_ERROR_MESSAGES = {
  raffle_not_found: 'Sorteo no encontrado',
  not_an_nft_prize: 'Ese sorteo no es de premio NFT',
  already_granted: 'Este NFT ya fue entregado antes',
  wallet_mismatch: 'Esa wallet no es la ganadora del sorteo',
  achievement_not_found: 'El logro NFT del sorteo no existe',
  supply_agotado: 'Ese NFT tiene tirada limitada y ya se agotó — no se puede emitir ni uno más'
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
    const staffName = getStaffName(req);
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
      result = grantWeeklyNftPrize(week, walletAddress, staffName);
    } else {
      const rid = parseInt(raffleId);
      if (!rid) return res.status(400).json({ error: 'ID de sorteo no válido' });
      result = grantNftPrize(rid, walletAddress, staffName);
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
    const staffName = getStaffName(req);
    const result = grantNftPrize(raffleId, walletAddress, staffName);
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
