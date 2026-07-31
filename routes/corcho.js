const express = require('express');
const router = express.Router();
const corcho = require('../services/corcho');

const ETH_REGEX = /^0x[a-fA-F0-9]{40}$/i;

// GET /api/corcho/balance?wallet=0x... — saldo, estadísticas e historial transaccional
router.get('/balance', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !ETH_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }

  try {
    const stats = corcho.getCorchoBalance(wallet);
    const ranking = corcho.getCorchoRanking(wallet);
    const history = corcho.getCorchoHistory(wallet, 30);
    const settings = corcho.getEconomySettings();
    const { getSessionCanjeCounts } = require('../db/database');

    res.json({
      wallet,
      balance: stats.balance,
      ranking: ranking,
      totalEarned: stats.totalEarned,
      totalSpent: stats.totalSpent,
      history,
      transferFee: settings.nftTransferFee,
      rates: settings,
      sessionCanjes: getSessionCanjeCounts(wallet)   // { tapa, cunca } de la sesión de hoy
    });
  } catch (e) {
    console.error('Error en GET /api/corcho/balance:', e.message);
    res.status(500).json({ error: 'Error obteniendo saldo del Banco do Corcho' });
  }
});

// GET /api/corcho/rates — tarifas públicas del Banco do Corcho
router.get('/rates', (req, res) => {
  try {
    res.json(corcho.getEconomySettings());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/transfer-nft — traspaso de pase/logro NFT pagando el peaje en $CORCHO
router.post('/transfer-nft', (req, res) => {
  const { fromWallet, toWallet, nftType, nftId } = req.body || {};

  if (!fromWallet || !ETH_REGEX.test(fromWallet)) {
    return res.status(400).json({ error: 'Wallet de origen no válida' });
  }
  if (!toWallet || !ETH_REGEX.test(toWallet)) {
    return res.status(400).json({ error: 'Wallet de destino no válida' });
  }
  if (fromWallet.toLowerCase() === toWallet.toLowerCase()) {
    return res.status(400).json({ error: 'No puedes traspasarte un NFT a ti mismo' });
  }
  if (!nftType || !['level', 'achievement'].includes(nftType)) {
    return res.status(400).json({ error: 'Tipo de NFT no válido (level o achievement)' });
  }
  if (!nftId) {
    return res.status(400).json({ error: 'ID de NFT no válido' });
  }

  try {
    let feeKey = nftType === 'level' ? `transfer_fee_${nftId}` : `transfer_fee_ach_${nftId}`;
    let feeSetting = require('../db/database').getSetting(feeKey, null);
    let fee = (feeSetting !== null && !isNaN(parseInt(feeSetting, 10))) ? parseInt(feeSetting, 10) : 0;

    const result = corcho.transferNftWithFee(fromWallet, toWallet, nftType, nftId, fee);


    if (!result.ok) {
      if (result.error === 'insufficient_balance') {
        return res.status(400).json({
          error: `Saldo insuficiente. El traspaso requiere ${fee} $CORCHO (saldo actual: ${result.currentBalance} $CORCHO).`
        });
      }
      if (result.error === 'nft_not_owned') {
        return res.status(400).json({ error: 'No posees este NFT o no está disponible para traspaso.' });
      }
      return res.status(400).json({ error: 'No se pudo realizar el traspaso.' });
    }

    res.json({
      success: true,
      message: `🎉 ¡Traspaso completado! NFT enviado a ${toWallet.slice(0,6)}…${toWallet.slice(-4)}. Peaje pagado: ${fee} $CORCHO.`,
      newBalance: result.newBalance
    });
  } catch (e) {
    console.error('Error en POST /api/corcho/transfer-nft:', e.message);
    res.status(500).json({ error: 'Error procesando traspaso de NFT' });
  }
});

// GET /api/corcho/packs — paquetes públicos activos de recarga en Euros (€)
router.get('/packs', (req, res) => {
  try {
    const { getCorchoPacks } = require('../db/database');
    res.json({ packs: getCorchoPacks(true) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/buy-pack — SOLICITAR compra de un paquete de $CORCHO.
// NO acredita monedas: el $CORCHO es dinero real (se paga en €). Se crea una
// solicitud PENDIENTE que el staff/admin confirma en la barra SOLO cuando el
// socio ha pagado. Sin esta validación cualquiera se autoacreditaría gratis.
router.post('/buy-pack', (req, res) => {
  const { walletAddress, packId } = req.body || {};
  if (!walletAddress || !ETH_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }

  try {
    const { db, createCorchoPackRequest } = require('../db/database');
    const pack = db.prepare(`SELECT * FROM corcho_packs WHERE id = ? AND active = 1`).get(packId);
    if (!pack) {
      return res.status(400).json({ error: 'Paquete de recarga no válido o inactivo' });
    }

    const { request, already } = createCorchoPackRequest({ walletAddress, pack });

    // Aviso EN VIVO al admin de la compra por cobrar (efectivo/tarjeta en taquilla).
    if (!already) {
      try {
        require('./raffle').broadcastCorchoPending({
          kind: 'compra',
          requestId: request.id,
          wallet: walletAddress,
          walletMasked: `${walletAddress.slice(0,6)}…${walletAddress.slice(-4)}`,
          packName: request.pack_name,
          coins: request.coins,
          priceEur: request.price_eur
        });
      } catch (_) {}
    }

    res.json({
      success: true,
      pending: true,
      request: {
        id: request.id,
        packName: request.pack_name,
        coins: request.coins,
        priceEur: request.price_eur
      },
      message: already
        ? `⏳ Xa tes esta compra pendente. Paga ${pack.price_eur}€ na barra e o camareiro cha validará (recibirás ${pack.coins.toLocaleString()} $CORCHO).`
        : `⏳ Compra rexistrada. Paga ${pack.price_eur}€ na barra: cando o camareiro ou o admin o confirme recibirás ${pack.coins.toLocaleString()} $CORCHO. Ata entón non se acredita nada.`
    });
  } catch (e) {
    console.error('Error en POST /api/corcho/buy-pack:', e.message);
    res.status(500).json({ error: 'Error procesando la solicitud de compra' });
  }
});

// GET /api/corcho/pending?wallet=0x... — compras y canjes pendientes del socio,
// para que su móvil muestre "pendiente de validar en la barra".
router.get('/pending', (req, res) => {
  const { wallet } = req.query;
  if (!wallet || !ETH_REGEX.test(wallet)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }
  try {
    const { getPendingCorchoPackRequests, getPendingRedemptions } = require('../db/database');
    const packs = getPendingCorchoPackRequests(wallet).map(r => ({
      id: r.id, packName: r.pack_name, coins: r.coins, priceEur: r.price_eur, createdAt: r.created_at
    }));
    const vouchers = getPendingRedemptions(wallet).map(v => ({
      code: v.code, itemName: v.item_name, itemEmoji: v.item_emoji,
      priceCorcho: v.price_corcho, expiresAt: v.expires_at
    }));
    res.json({ packs, vouchers });
  } catch (e) {
    console.error('Error en GET /api/corcho/pending:', e.message);
    res.status(500).json({ error: 'Error obteniendo pendientes' });
  }
});


// GET /api/corcho/items — catálogo activo de canjes en $CORCHO
router.get('/items', (req, res) => {
  try {
    const { getCorchoItems } = require('../db/database');
    res.json({ items: getCorchoItems(true) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/corcho/economy-info — información de la economía, reglas, quema y supply
router.get('/economy-info', (req, res) => {
  try {
    const { isCorchoStoreEventScheduledThisWeek, getCorchoGlobalSupply, processFifoBurnForWallet } = require('../db/database');
    const { wallet } = req.query;
    let walletStats = null;
    let burnedThisCheck = 0;

    if (wallet && ETH_REGEX.test(wallet)) {
      const bRes = processFifoBurnForWallet(wallet);
      burnedThisCheck = bRes.burned || 0;
      walletStats = corcho.getCorchoBalance(wallet);
    }

    const supply = getCorchoGlobalSupply();
    // En Modo Vacaciones el local está cerrado: la tienda de consumiciones no abre
    // (aunque haya evento). La de NFTs (traspaso/compra) sigue abierta siempre.
    const vacationMode = !!corcho.getEconomySettings().vacationMode;
    const isStoreOpen = isCorchoStoreEventScheduledThisWeek() && !vacationMode;

    res.json({
      storeOpenForItems: isStoreOpen,
      vacationMode,
      globalSupply: supply.currentSupply,
      totalEarned: supply.totalEarned,
      totalBurned: supply.totalBurned,
      walletStats,
      burnedThisCheck,
      rules: [
        { title: '1 Canje por Producto/Noche', desc: 'Cada día de furancho puedes canjear máximo 1 unidad de cada consumición (1 tapa, 1 cunca, 1 ración...).' },
        { title: 'Caducidad FIFO (3 meses)', desc: 'Los $CORCHO no consumidos en eventos se queman a los 3 meses (se gastan primero las monedas más antiguas).' },
        { title: 'Quema Transparente', desc: 'Al quemar monedas no canjeadas, desaparecen del suministro total y quedan registradas públicamente.' },
        { title: 'Tienda Ligada a Eventos', desc: 'La tienda de consumiciones solo abre en semanas con evento de Furancho programado. La tienda de NFTs (Meme VIP) abre siempre.' },
        { title: 'Compensación en Taquilla', desc: 'Los $CORCHO se obtienen participando en el Furancho o mediante paquetes fijos en taquilla.' }
      ]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/redeem-item — canjear un producto/consumición con $CORCHO
router.post('/redeem-item', (req, res) => {
  const { walletAddress, itemId } = req.body || {};
  if (!walletAddress || !ETH_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }
  if (!itemId) {
    return res.status(400).json({ error: 'Selecciona un artículo para canjear' });
  }

  try {
    const { db, spendCorchoCoins, createRedemptionVoucher, corchoItemCategory, sessionCanjeCount, decrementCorchoItemStock, isCorchoStoreEventScheduledThisWeek } = require('../db/database');

    // 0. Modo Vacaciones: el local está cerrado → NO se canjean consumiciones
    //    (tapas/cuncas). El traspaso y la compra de NFTs (meme, etc.) siguen activos.
    try {
      if (require('../services/corcho').getEconomySettings().vacationMode) {
        return res.status(400).json({
          error: '🏖️ O local está de vacacións: os canxes de consumición están pechados ata a volta. Podes seguir traspasando ou mercando NFTs co teu $CORCHO.',
          vacationClosed: true
        });
      }
    } catch (_) {}

    // 1. Verificar si hay evento de Furancho esta semana para abrir la tienda de consumiciones
    if (!isCorchoStoreEventScheduledThisWeek()) {
      return res.status(400).json({
        error: '🔒 A tienda de consumicións está pechada esta semana porque non hai ningún evento do Furancho programado. O tempo corre para a quema FIFO dos corchos. Só puedes usar $CORCHO para comprar NFTs (como o Meme VIP).',
        storeClosed: true
      });
    }

    const item = db.prepare(`SELECT * FROM corcho_items WHERE id = ? AND active = 1`).get(itemId);
    if (!item) {
      return res.status(404).json({ error: 'El producto o canje ya no está disponible' });
    }

    // Comprobar stock disponible
    if (item.stock !== null && item.stock !== undefined && item.stock <= 0) {
      return res.status(400).json({ error: '🔴 Producto o canje agotado (0 unidades disponibles en stock).' });
    }

    // Límite: máximo 1 unidad de este producto/categoría por día de evento
    const category = corchoItemCategory(item.name);
    if (category && sessionCanjeCount(walletAddress, category) >= 1) {
      const catName = category === 'tapa' ? 'tapa' : 'cunca';
      return res.status(400).json({
        error: `Xa canxeaches a túa ${catName} desta sesión. Só 1 por cada producto por noite de furancho, neno.`,
        limitReached: true
      });
    }

    const spendRes = spendCorchoCoins(
      walletAddress,
      item.price_corcho,
      'item_redemption',
      `🎁 Canje: ${item.emoji} ${item.name} (-${item.price_corcho} $CORCHO)`,
      `redeem_${item.id}_${Date.now()}`
    );

    if (!spendRes.ok) {
      if (spendRes.error === 'insufficient_balance') {
        return res.status(400).json({
          error: `Saldo insuficiente. Requiere ${item.price_corcho.toLocaleString()} $CORCHO (tienes ${spendRes.currentBalance.toLocaleString()} $CORCHO).`
        });
      }
      return res.status(400).json({ error: 'No se pudo procesar el canje.' });
    }

    try {
      const aliasRow = db.prepare(`SELECT alias FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?)`).get(walletAddress);
      const aliasStr = aliasRow && aliasRow.alias ? aliasRow.alias : (walletAddress.substring(0,6) + '...');
      const msg = `🔥 ${aliasStr} acaba de quemar ${item.price_corcho.toLocaleString()} $CORCHO en un ${item.name}. ¡Que le quiten lo bailao!`;
      const { injectSystemMuroMessage } = require('../db/database');
      injectSystemMuroMessage(msg);
    } catch(e) {}

    // Descontar 1 unidad del stock si es un artículo con unidades limitadas
    if (item.stock !== null && item.stock !== undefined && item.stock > 0) {
      try { decrementCorchoItemStock(item.id); } catch (_) {}
    }

    // Vale server-side con código REAL: el staff/admin lo valida al entregar la
    // consumición. Antes el código era cosmético (aleatorio en el móvil) y nadie
    // lo comprobaba — ahora la entrega queda registrada y es anti-doble-canje.
    let voucher = null;
    try {
      voucher = createRedemptionVoucher({ walletAddress, item, ttlMinutes: 15 });
    } catch (ve) {
      console.error('Error creando vale de canje:', ve.message);
    }

    // Aviso EN VIVO al admin con el código clave: así la validación no depende solo
    // del móvil del cliente. El staff además lo ve al fichar / en el panel.
    if (voucher) {
      try {
        require('./raffle').broadcastCorchoPending({
          kind: 'canje',
          code: voucher.code,
          wallet: walletAddress,
          walletMasked: `${walletAddress.slice(0,6)}…${walletAddress.slice(-4)}`,
          item: `${item.emoji} ${item.name}`,
          priceCorcho: item.price_corcho
        });
      } catch (_) {}
    }

    res.json({
      success: true,
      item,
      voucher: voucher ? { code: voucher.code, expiresAt: voucher.expires_at } : null,
      message: `🎉 ¡Canje realizado! Enseña el vale en la barra: el camarero lo validará al darte ${item.emoji} ${item.name}.`,
      newBalance: spendRes.newBalance
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/cancel-pack-request — el cliente anula su solicitud de recarga pendiente
router.post('/cancel-pack-request', (req, res) => {
  const { walletAddress, requestId } = req.body || {};
  const id = parseInt(requestId, 10);
  if (!walletAddress || !id) return res.status(400).json({ error: 'Datos no válidos' });
  try {
    const { db, cancelCorchoPackRequest } = require('../db/database');
    const packReq = db.prepare(`SELECT * FROM corcho_pack_requests WHERE id = ?`).get(id);
    if (!packReq) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (packReq.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const result = cancelCorchoPackRequest(id, 'client');
    if (!result.ok) return res.status(400).json({ error: 'No se pudo anular la solicitud' });
    try {
      const { broadcastToAdmins, broadcastToStaff } = require('./raffle');
      broadcastToAdmins('corcho_updated', { kind: 'pack_cancel', id });
      broadcastToStaff('corcho_updated', { kind: 'pack_cancel', id });
    } catch (_) {}
    res.json({ success: true, message: 'Solicitud de recarga anulada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/cancel-voucher — el cliente anula un vale pendiente y recibe reembolso de $CORCHO
router.post('/cancel-voucher', (req, res) => {
  const { walletAddress, code } = req.body || {};
  if (!walletAddress || !code) return res.status(400).json({ error: 'Datos no válidos' });
  try {
    const { getRedemptionByCode, cancelRedemptionVoucher } = require('../db/database');
    const v = getRedemptionByCode(code);
    if (!v) return res.status(404).json({ error: 'Vale no encontrado' });
    if (v.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const result = cancelRedemptionVoucher(code, 'client', true);
    if (!result.ok) return res.status(400).json({ error: 'No se pudo anular el vale' });
    try {
      const { broadcastToAdmins, broadcastToStaff, broadcast } = require('./raffle');
      broadcastToAdmins('corcho_updated', { kind: 'voucher_cancel', code });
      broadcastToStaff('corcho_updated', { kind: 'voucher_cancel', code });
      broadcast('corcho_balance_update', { wallet: walletAddress }, walletAddress);
    } catch (_) {}
    res.json({ success: true, refunded: !!result.refunded, message: 'Vale anulado y $CORCHO devueltos' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── PASAPORTE DE VERANO (1 sello al día) ─────────────────────────────────────
const SUMMER_MAX_DAILY_STAMPS = 1;

router.get('/summer/status', (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress || !ETH_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }

  try {
    const { db } = require('../db/database');
    const stamps = db.prepare(`SELECT stamp_date FROM summer_stamps WHERE LOWER(wallet_address) = LOWER(?) ORDER BY id ASC`).all(walletAddress);
    const totalStamps = stamps.length;
    
    // Check if they won
    const winner = db.prepare(`SELECT position, prize_granted FROM summer_passport_winners WHERE LOWER(wallet_address) = LOWER(?)`).get(walletAddress);

    // Can they claim today? 1 sello por día
    const today = new Date().toISOString().slice(0, 10);
    const todayStamps = stamps.filter(s => s.stamp_date === today).length;
    const canClaimToday = (today >= '2026-07-31') && (todayStamps < SUMMER_MAX_DAILY_STAMPS) && (totalStamps < 20);

    res.json({
      success: true,
      totalStamps,
      todayStamps,
      maxDailyStamps: SUMMER_MAX_DAILY_STAMPS,
      canClaimToday,
      winnerInfo: winner || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/summer/stamp', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !ETH_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }

  try {
    const { db } = require('../db/database');
    const today = new Date().toISOString().slice(0, 10);

    if (today < '2026-07-31') {
      return res.status(400).json({ error: 'El pasaporte de verano arranca el 31 de Julio. ¡Vuelve ese día!' });
    }

    const stamps = db.prepare(`SELECT COUNT(*) as c FROM summer_stamps WHERE LOWER(wallet_address) = LOWER(?)`).get(walletAddress).c;
    if (stamps >= 20) {
      return res.status(400).json({ error: 'Ya has completado tu pasaporte (20 sellos).' });
    }

    const todayStamps = db.prepare(`SELECT COUNT(*) as c FROM summer_stamps WHERE LOWER(wallet_address) = LOWER(?) AND stamp_date = ?`).get(walletAddress, today).c;
    if (todayStamps >= SUMMER_MAX_DAILY_STAMPS) {
      return res.status(400).json({ error: 'Ya has puesto tu sello de hoy. Vuelve mañana.' });
    }

    db.prepare(`INSERT INTO summer_stamps (wallet_address, stamp_date) VALUES (?, ?)`).run(walletAddress, today);

    const newTotal = stamps + 1;
    const newTodayStamps = todayStamps + 1;
    let justCompleted = false;
    let position = null;

    if (newTotal === 20) {
      // Registrar ganador
      const currentWinners = db.prepare(`SELECT COUNT(*) as c FROM summer_passport_winners`).get().c;
      position = currentWinners + 1;
      db.prepare(`
        INSERT INTO summer_passport_winners (wallet_address, position)
        VALUES (?, ?)
      `).run(walletAddress, position);
      justCompleted = true;
    }

    res.json({
      success: true,
      totalStamps: newTotal,
      todayStamps: newTodayStamps,
      maxDailyStamps: SUMMER_MAX_DAILY_STAMPS,
      justCompleted,
      position
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/corcho/leaderboard — ranking público de $CORCHO para competir entre socios
router.get('/leaderboard', (req, res) => {
  try {
    const { db } = require('../db/database');
    const userWallet = (req.query.wallet || '').toLowerCase();
    
    // Top 20 por saldo $CORCHO
    const topRows = db.prepare(`
      SELECT b.wallet_address, b.balance,
             p.alias,
             (SELECT MAX(level) FROM mints WHERE LOWER(wallet_address) = LOWER(b.wallet_address) AND status = 'success') as level
      FROM corcho_balances b
      LEFT JOIN user_profiles p ON LOWER(p.wallet_address) = LOWER(b.wallet_address)
      WHERE b.balance > 0
      ORDER BY b.balance DESC, b.wallet_address ASC
      LIMIT 20
    `).all();

    const leaderboard = topRows.map((r, i) => {
      const w = r.wallet_address.toLowerCase();
      const shortW = `${w.slice(0, 6)}…${w.slice(-4)}`;
      return {
        rank: i + 1,
        walletAddress: w,
        walletMasked: shortW,
        displayName: r.alias ? `${r.alias}` : `Socio ${shortW}`,
        balance: r.balance,
        level: r.level || 1,
        isMe: userWallet ? (w === userWallet) : false
      };
    });

    let userRank = null;
    if (userWallet) {
      const foundIdx = leaderboard.findIndex(x => x.isMe);
      if (foundIdx >= 0) {
        userRank = foundIdx + 1;
      } else {
        const myBal = db.prepare(`SELECT balance FROM corcho_balances WHERE LOWER(wallet_address) = LOWER(?)`).get(userWallet);
        if (myBal && myBal.balance > 0) {
          const ahead = db.prepare(`SELECT COUNT(*) as c FROM corcho_balances WHERE balance > ?`).get(myBal.balance);
          userRank = (ahead ? ahead.c : 0) + 1;
        }
      }
    }

    res.json({ leaderboard, userRank });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/corcho/daily-streak/status — estado de racha diaria y recompensa disponible
router.get('/daily-streak/status', (req, res) => {
  const walletAddress = (req.query.wallet || '').toLowerCase();
  if (!walletAddress) return res.status(400).json({ error: 'Falta wallet' });
  try {
    const { db } = require('../db/database');
    const corcho = require('../services/corcho');
    const todayStr = new Date().toISOString().slice(0, 10);
    const row = db.prepare(`SELECT current_streak, last_claimed_date FROM user_daily_streaks WHERE LOWER(wallet_address) = LOWER(?)`).get(walletAddress);
    
    let streak = row ? row.current_streak : 0;
    const lastDate = row ? row.last_claimed_date : null;
    const alreadyClaimed = (lastDate === todayStr);

    if (lastDate && !alreadyClaimed) {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
      if (lastDate !== yesterday) {
        streak = 0;
      }
    }

    const vacationMode = !!corcho.getEconomySettings().vacationMode;
    const rewardAmount = vacationMode ? 2 : (streak >= 7 ? 3 : streak >= 3 ? 2 : 1);

    res.json({
      streak,
      alreadyClaimed,
      rewardAmount,
      vacationMode,
      vacationMessage: vacationMode ? '🏖️ ¡Estamos de vacaciones disfrutando del sol y la playa! Conéctate a diario para mantener tu racha y ganar tus +2 $CORCHO diarios 🍷☀️' : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/corcho/daily-streak/claim — reclamar recompensa de racha diaria
router.post('/daily-streak/claim', (req, res) => {
  const walletAddress = (req.body.walletAddress || '').toLowerCase();
  if (!walletAddress) return res.status(400).json({ error: 'Falta walletAddress' });
  try {
    const { db } = require('../db/database');
    const corcho = require('../services/corcho');
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

    const row = db.prepare(`SELECT current_streak, last_claimed_date FROM user_daily_streaks WHERE LOWER(wallet_address) = LOWER(?)`).get(walletAddress);
    
    if (row && row.last_claimed_date === todayStr) {
      return res.status(400).json({ error: 'Ya has reclamado tu recompensa de hoy. ¡Vuelve mañana para continuar tu racha!' });
    }

    let newStreak = 1;
    if (row && row.last_claimed_date === yesterdayStr) {
      newStreak = (row.current_streak || 0) + 1;
    }

    const vacationMode = !!corcho.getEconomySettings().vacationMode;
    const rewardAmount = vacationMode ? 2 : (newStreak >= 7 ? 3 : newStreak >= 3 ? 2 : 1);

    db.prepare(`
      INSERT INTO user_daily_streaks (wallet_address, current_streak, last_claimed_date, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(wallet_address) DO UPDATE SET
        current_streak = excluded.current_streak,
        last_claimed_date = excluded.last_claimed_date,
        updated_at = datetime('now')
    `).run(walletAddress, newStreak, todayStr);

    corcho.addCorchoTransaction({
      walletAddress,
      amount: rewardAmount,
      type: 'daily_streak',
      description: `🔥 Recompensa Racha Diaria (${newStreak} día${newStreak > 1 ? 's' : ''})`,
      referenceId: `streak_${todayStr}_${walletAddress}`
    });

    try {
      const { broadcast } = require('./raffle');
      broadcast('corcho_balance_update', { wallet: walletAddress }, walletAddress);
    } catch (_) {}

    res.json({
      success: true,
      streak: newStreak,
      rewardAmount,
      message: vacationMode
        ? `🏖️ ¡+${rewardAmount} $CORCHO añadidos! Estás de vacaciones acumulando racha de ${newStreak} día${newStreak > 1 ? 's' : ''} seguidos 🍷☀️`
        : `🔥 ¡+${rewardAmount} $CORCHO añadidos! Racha de ${newStreak} día${newStreak > 1 ? 's' : ''} seguidos.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

