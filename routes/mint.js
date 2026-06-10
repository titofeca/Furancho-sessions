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
const { insertMint, updateMintStatus, checkDuplicate } = require('../db/database');
const { sendNftApprovalEmail } = require('../services/notifications');

const LEVEL_NAMES = {
  1: 'Cautivo',
  2: 'O Cunqueiro',
  3: 'O Larpeiro',
  4: 'O Presidente do Furancho'
};


// POST /api/mint/entry — abre sesión y cuenta la visita en el momento de entrada
router.post('/entry', mintLimiter, async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Falta walletAddress' });

  try {
    const { getVisitCount, checkRecentVisit, openSession } = require('../db/database');
    const alreadyVisitedThisWeek = checkRecentVisit(walletAddress, 168);

    // Abrir sesión — se marca como visita en openSession si hai evento hoxe
    openSession(walletAddress);

    // Visit count post-entrada (xa inclúe a visita de hoxe se hai evento)
    const visitCount = getVisitCount(walletAddress);

    return res.json({
      success: true,
      action: 'entry',
      isNew: visitCount === 1 && !alreadyVisitedThisWeek,
      visitCount,
      alreadyCounted: alreadyVisitedThisWeek,
      message: visitCount === 1 && !alreadyVisitedThisWeek
        ? '¡Benvido a Furancho Sessions!'
        : `¡Benvido de volta! Levas ${visitCount} visita${visitCount !== 1 ? 's' : ''}.`
    });
  } catch (error) {
    console.error('Error en /entry:', error.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});

// POST /api/mint/exit — cierra sesión de forma dedicada (sin abrir nueva visita)
// Soluciona la race condition donde marcharDoFurancho(), fichaSalida() y autoRegistrarSalida()
// llamaban al mismo endpoint que la entrada, pudiendo generar visitas fantasma o dobles.
const _exitLocks = new Set(); // previene dobles salidas simultáneas por la misma wallet
router.post('/exit', mintLimiter, (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress))
    return res.status(400).json({ error: 'Falta walletAddress' });

  if (_exitLocks.has(walletAddress.toLowerCase())) {
    return res.json({ success: true, action: 'already_processing' });
  }
  _exitLocks.add(walletAddress.toLowerCase());
  setTimeout(() => _exitLocks.delete(walletAddress.toLowerCase()), 5000);

  try {
    const { closeSession, db } = require('../db/database');
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL LIMIT 1`).get(walletAddress);
    if (!activeSession) {
      _exitLocks.delete(walletAddress.toLowerCase());
      return res.json({ success: true, action: 'no_session' });
    }
    closeSession(walletAddress);
    _exitLocks.delete(walletAddress.toLowerCase());
    return res.json({ success: true, action: 'exit' });
  } catch (e) {
    _exitLocks.delete(walletAddress.toLowerCase());
    console.error('Error en /exit:', e.message);
    res.status(500).json({ error: 'Error al registrar salida' });
  }
});

// POST /api/mint/create-wallet
// Genera una billetera Web3 aleatoria con mnemónico de 12 palabras
router.post('/create-wallet', mintLimiter, (req, res) => {
  try {
    const wallet = Wallet.createRandom();
    res.json({
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase || null   // 12 palabras BIP39
    });
  } catch (error) {
    console.error('Error al generar billetera:', error);
    res.status(500).json({ error: 'Error al generar la billetera anónima' });
  }
});

// POST /api/mint/recover-from-phrase
// Recupera una cuenta a partir de las 12 palabras mnemónicas
router.post('/recover-from-phrase', mintLimiter, (req, res) => {
  const { phrase } = req.body;
  if (!phrase || typeof phrase !== 'string') return res.status(400).json({ error: 'Falta la frase' });
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) return res.status(400).json({ error: 'La frase debe tener exactamente 12 palabras' });
  try {
    const wallet = Wallet.fromPhrase(words.join(' '));
    res.json({ address: wallet.address, privateKey: wallet.privateKey });
  } catch (e) {
    res.status(400).json({ error: 'Frase de recuperación no válida. Comprueba que las palabras son correctas.' });
  }
});

// POST /api/mint
// Body: { walletAddress, email, level (opcional para salto manual — requiere adminToken) }
router.post('/', mintLimiter, async (req, res) => {
  const { walletAddress, email, level, adminToken } = req.body;

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
    const { insertVisit, getVisitCount, checkRecentVisit, openSession, closeSession, clearStaleMint, db } = require('../db/database');
    

    // ==== CHECK COOLDOWN (Anti-Fraude) ====
    // No aplica a saltos de nivel manuales (level) para fines de demostración/admin,
    // ni tampoco si el usuario tiene una sesión activa abierta (es decir, está saliendo del evento).
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL LIMIT 1`).get(walletAddress);
    const hasActiveSession = !!activeSession;

    if (!level && !hasActiveSession && checkRecentVisit(walletAddress, 168)) {
      return res.status(429).json({ 
        error: 'Solo puedes escanear el código y acumular visita una vez cada 7 días.',
        action: 'cooldown'
      });
    }
    // ======================================

    // Registrar la visita actual
    closeSession(walletAddress);
    
    // Obtener total de visitas contando esta
    const visitCount = getVisitCount(walletAddress);

    // Determinar si corresponde un nivel por salto manual o por visitas
    let targetLevel = null;
    let manualLevel = parseInt(level);

    if (manualLevel && [1, 2, 3, 4].includes(manualLevel)) {
      // QR de regalo — solo permitido con token de admin válido
      const { verifyAdminToken } = require('./admin');
      if (!adminToken || !verifyAdminToken(adminToken)) {
        return res.status(403).json({ error: 'No autorizado para asignar nivel manual.' });
      }
      targetLevel = manualLevel;
      if (checkDuplicate(walletAddress, sanitizedEmail, targetLevel)) {
        return res.status(409).json({ error: `Ya tienes el pase de ${LEVEL_NAMES[targetLevel]}.`, action: 'duplicate' });
      }
    } else {
      if (visitCount === 1)       targetLevel = 1; // Nv1 Cautivo — 1ª visita
      else if (visitCount === 2)  targetLevel = 2; // Nv2 O Cunqueiro — 2ª visita
      else if (visitCount === 4)  targetLevel = 3; // Nv3 O Larpeiro — 4ª visita (NFT real)
      else if (visitCount === 12) targetLevel = 4; // Nv4 O Presidente — 12ª visita (NFT real)
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

    // Verificar duplicado por seguridad en visitas normales
    if (!manualLevel && checkDuplicate(walletAddress, sanitizedEmail, targetLevel)) {
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: `Visita ${visitCount} registrada. Ya tenías el pase de este hito.`
      });
    }

    // Limpiar cualquier mint bloqueado (pending/failed) antes de insertar de nuevo
    clearStaleMint(walletAddress, targetLevel);

    if (targetLevel <= 2) {
      // Nv1/Nv2 — off-chain: registro instantáneo sin blockchain
      insertMint({ email: sanitizedEmail, level: targetLevel, levelName, walletAddress, status: 'success', ipAddress: req.ip });
      return res.json({
        success: true,
        action: 'level_up',
        visitCount,
        levelName,
        level: targetLevel,
        walletAddress,
        message: `¡Bienvenido al nivel ${levelName}!`
      });
    }

    // Nv3/Nv4 — requieren aprobación del admin antes de ir a blockchain
    const mintId = insertMint({ email: sanitizedEmail, level: targetLevel, levelName, walletAddress, status: 'pending_approval', ipAddress: req.ip });

    const adminUrl = `${process.env.APP_URL || 'https://furancho.up.railway.app'}/admin`;
    sendNftApprovalEmail({ mintId, walletAddress, level: targetLevel, levelName, visitCount, adminUrl }).catch(() => {});

    return res.json({
      success: true,
      action: 'pending_approval',
      visitCount,
      levelName,
      level: targetLevel,
      walletAddress,
      message: `¡Lo conseguiste, neno! Tu Tarjeta ${levelName} está siendo preparada. En breve es tuya.`
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
    const { getClaimedLevels, getVisitCount, db } = require('../db/database');
    const levels = getClaimedLevels(wallet);
    const visitCount = getVisitCount(wallet);
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE wallet_address = ? AND exit_time IS NULL LIMIT 1`).get(wallet);
    const pendingApproval = db.prepare(`SELECT level, level_name FROM mints WHERE wallet_address = ? AND status = 'pending_approval' ORDER BY level DESC LIMIT 1`).get(wallet);
    // Número de serie por nivel (cuántos obtuvieron ese nivel antes que esta wallet)
    const serialsByLevel = {};
    levels.forEach(lvl => {
      const row = db.prepare(`SELECT mint_serial FROM mints WHERE wallet_address = ? AND level = ? AND status != 'failed' LIMIT 1`).get(wallet, lvl);
      if (row?.mint_serial) serialsByLevel[lvl] = row.mint_serial;
    });
    res.json({ levels, visitCount, hasActiveSession: !!activeSession, pendingApproval: pendingApproval || null, serialsByLevel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



module.exports = router;
