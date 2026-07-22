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
    const history = corcho.getCorchoHistory(wallet, 30);
    const settings = corcho.getEconomySettings();

    res.json({
      wallet,
      balance: stats.balance,
      totalEarned: stats.totalEarned,
      totalSpent: stats.totalSpent,
      history,
      transferFee: settings.nftTransferFee,
      rates: settings
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
    let fee = (feeSetting !== null && !isNaN(parseInt(feeSetting, 10))) ? parseInt(feeSetting, 10) : corcho.getRate('nftTransferFee');

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
    const { db, spendCorchoCoins, createRedemptionVoucher } = require('../db/database');
    const item = db.prepare(`SELECT * FROM corcho_items WHERE id = ? AND active = 1`).get(itemId);
    if (!item) {
      return res.status(404).json({ error: 'El producto o canje ya no está disponible' });
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

    // Vale server-side con código REAL: el staff/admin lo valida al entregar la
    // consumición. Antes el código era cosmético (aleatorio en el móvil) y nadie
    // lo comprobaba — ahora la entrega queda registrada y es anti-doble-canje.
    let voucher = null;
    try {
      voucher = createRedemptionVoucher({ walletAddress, item, ttlMinutes: 15 });
    } catch (ve) {
      console.error('Error creando vale de canje:', ve.message);
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

module.exports = router;

