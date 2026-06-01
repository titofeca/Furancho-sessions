require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Configuración de Rate Limiting (Máximo 10 peticiones por minuto por IP para evitar bots)
const mintLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 10,
  message: { error: 'Demasiadas peticiones. Inténtalo de nuevo en un minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const { Wallet } = require('ethers');
const { mintNFT, DEMO_MODE } = require('../services/crossmint');
const { insertMint, updateMintStatus, checkDuplicate } = require('../db/database');

const LEVEL_NAMES = {
  1: 'Cautivo',
  2: 'O Cunqueiro',
  3: 'O Larpeiro',
  4: 'O Presidente do Furancho'
};

// POST /api/mint/create-wallet
// Genera una billetera Web3 aleatoria y anónima en el backend
router.post('/create-wallet', (req, res) => {
  try {
    const wallet = Wallet.createRandom();
    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey
    });
  } catch (error) {
    console.error('Error al generar billetera:', error);
    res.status(500).json({ error: 'Error al generar la billetera anónima' });
  }
});

// POST /api/mint
// Body: { walletAddress, email, level (opcional para salto manual) }
router.post('/', mintLimiter, async (req, res) => {
  const { walletAddress, email, level } = req.body;

  // Validaciones
  if (!walletAddress) {
    return res.status(400).json({ error: 'Dirección de billetera es obligatoria' });
  }

  // Validar formato de billetera EVM (0x...)
  const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!ethAddressRegex.test(walletAddress)) {
    return res.status(400).json({ error: 'Dirección de billetera no válida' });
  }

  // Validar email si se proporciona
  let sanitizedEmail = null;
  if (email && email.trim() !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Formato de correo no válido' });
    }
    sanitizedEmail = email.toLowerCase().trim();
  }

  try {
    const { insertVisit, getVisitCount, checkRecentVisit } = require('../db/database');
    

    // ==== CHECK COOLDOWN (Anti-Fraude) ====
    // No aplica a saltos de nivel manuales (level) para fines de demostración/admin
    if (!level && checkRecentVisit(walletAddress, 168)) {
      return res.status(429).json({ 
        error: 'Solo puedes escanear el código y acumular visita una vez cada 7 días.',
        action: 'cooldown'
      });
    }
    // ======================================

    // Registrar la visita actual
    insertVisit(walletAddress, sanitizedEmail, req.ip);
    
    // Obtener total de visitas contando esta
    const visitCount = getVisitCount(walletAddress);

    // Determinar si corresponde un nivel por salto manual o por visitas
    let targetLevel = null;
    let manualLevel = parseInt(level);

    if (manualLevel && [1, 2, 3, 4].includes(manualLevel)) {
      targetLevel = manualLevel;
    } else {
      if (visitCount === 1) targetLevel = 1;
      else if (visitCount === 2) targetLevel = 2;
      else if (visitCount === 5) targetLevel = 3;
      else if (visitCount === 10) targetLevel = 4;
    }

    if (!targetLevel) {
      // No toca premio, solo registrar visita
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: `Visita ${visitCount} registrada correctamente.`
      });
    }

    const levelName = LEVEL_NAMES[targetLevel];

    // Verificar duplicado por seguridad (aunque por lógica de visitas no debería pasar)
    const isDuplicate = checkDuplicate(walletAddress, sanitizedEmail, targetLevel);
    if (isDuplicate) {
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: `Visita ${visitCount} registrada. Ya tenías el pase de este hito.`
      });
    }

    // Insertar registro de mint en DB (estado: pending)
    const mintId = insertMint({
      email: sanitizedEmail,
      level: targetLevel,
      levelName,
      walletAddress,
      status: 'pending',
      ipAddress: req.ip
    });

    // Mintear con Crossmint (o demo)
    const result = await mintNFT({
      email: sanitizedEmail,
      walletAddress,
      level: targetLevel,
      levelName
    });

    // Actualizar estado en DB
    updateMintStatus(mintId, 'success', result.walletAddress);

    console.log(`✅ NFT minteado por visita ${visitCount}: ${levelName} → ${result.walletAddress} (${sanitizedEmail || 'anónimo'})`);

    return res.json({
      success: true,
      action: 'mint',
      visitCount,
      levelName,
      level: targetLevel,
      walletAddress: result.walletAddress,
      demo: DEMO_MODE,
      message: `¡Tu Pase ${levelName} está en camino!`
    });

  } catch (error) {
    console.error('❌ Error processando visita/mint:', error.message);
    return res.status(500).json({
      error: 'mint_failed',
      message: 'Error al procesar tu visita. Inténtalo de nuevo.'
    });
  }
});

// GET /api/mint/status/:actionId (opcional, para polling)
router.get('/status/:actionId', async (req, res) => {
  const { getMintStatus } = require('../services/crossmint');
  try {
    const status = await getMintStatus(req.params.actionId);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mint/history?wallet=0x...
router.get('/history', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Wallet es requerida' });
  try {
    const { getClaimedLevels, getVisitCount } = require('../db/database');
    const levels = getClaimedLevels(wallet);
    const visitCount = getVisitCount(wallet);
    res.json({ levels, visitCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
