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

// PACKS DE RECARGA DISPONIBLES
const BUY_PACKS = {
  pack_5: { id: 'pack_5', name: 'Paquete Cunca', coins: 500, priceEur: 5 },
  pack_10: { id: 'pack_10', name: 'Paquete Garrafa', coins: 1100, priceEur: 10, bonus: '100 $CORCHO gratis' },
  pack_20: { id: 'pack_20', name: 'Paquete Presidente', coins: 2500, priceEur: 20, bonus: '500 $CORCHO gratis' }
};

// POST /api/corcho/buy-pack — comprar paquete de CorchoCoins
router.post('/buy-pack', (req, res) => {
  const { walletAddress, packId } = req.body || {};
  if (!walletAddress || !ETH_REGEX.test(walletAddress)) {
    return res.status(400).json({ error: 'Wallet no válida' });
  }
  const pack = BUY_PACKS[packId];
  if (!pack) {
    return res.status(400).json({ error: 'Paquete de recarga no válido' });
  }

  try {
    // Registra la recarga en el Banco do Corcho
    const result = corcho.addCorchoCoins(
      walletAddress,
      pack.coins,
      'buy_pack',
      `💳 Recarga ${pack.name} (+${pack.coins} $CORCHO por ${pack.priceEur}€)`,
      `buy_${packId}_${Date.now()}`
    );

    res.json({
      success: true,
      message: `🎉 ¡Recarga efectuada! Has recibido ${pack.coins} $CORCHO.`,
      newBalance: result.newBalance
    });
  } catch (e) {
    console.error('Error en POST /api/corcho/buy-pack:', e.message);
    res.status(500).json({ error: 'Error procesando recarga' });
  }
});

module.exports = router;
