require('dotenv').config();
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');



const LEVEL_NAMES = {
  1: 'Cautivo',
  2: 'O Cunqueiro',
  3: 'O Larpeiro',
  4: 'O Presidente do Furancho'
};

// Opciones de QR con estilo Furancho
const QR_OPTIONS = {
  errorCorrectionLevel: 'H',
  type: 'png',
  margin: 3,
  width: 800,
  color: {
    dark: '#1E3A5F',
    light: '#FFFFFF'
  }
};

const QR_OPTIONS_BY_LEVEL = {
  1: { ...QR_OPTIONS, color: { dark: '#8B1918', light: '#FFFFFF' } }, // vino sobre blanco
  2: { ...QR_OPTIONS, color: { dark: '#1a6e6e', light: '#FFFFFF' } }, // teal sobre blanco
  3: { ...QR_OPTIONS, color: { dark: '#8B6914', light: '#FFFFFF' } }, // dorado sobre blanco
  4: { ...QR_OPTIONS, color: { dark: '#1E3A5F', light: '#FFFFFF' } }  // azul marino sobre blanco
};


// GET /api/qr/entry — genera QR de entrada (Fichaje Inicial)
router.get('/entry', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/entry`;
  const options = { ...QR_OPTIONS, color: { dark: '#116530', light: '#FFFFFF' } }; // Verde

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qr-furancho-entry.png"`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/entry/download
router.get('/entry/download', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/entry`;
  const options = { ...QR_OPTIONS, width: 1200, color: { dark: '#116530', light: '#FAFAFA' } };

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);
    const outputDir = path.join(__dirname, '..', 'qr-output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    const filePath = path.join(outputDir, 'qr-furancho-entry.png');
    fs.writeFileSync(filePath, qrBuffer);

    res.download(filePath, 'QR_Entrada_Furancho.png');
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/checkin — genera QR de check-in unificado
router.get('/checkin', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/claim`;
  const options = { ...QR_OPTIONS, color: { dark: '#8B0000', light: '#FFFFFF' } };

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qr-furancho-checkin.png"`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/checkin/download — descarga el QR unificado
router.get('/checkin/download', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/claim`;
  const options = { ...QR_OPTIONS, width: 1200, color: { dark: '#8B0000', light: '#FAFAFA' } };

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);

    const outputDir = path.join(__dirname, '..', 'qr-output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `qr-checkin.png`);
    fs.writeFileSync(filePath, qrBuffer);

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="QR-Furancho-CheckIn.png"`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/:level — genera QR como imagen PNG (legacy)
router.get('/:level', async (req, res) => {
  const level = parseInt(req.params.level);
  if (![1, 2, 3, 4].includes(level)) {
    return res.status(400).send('Nivel no válido');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/claim?level=${level}`;
  const options = QR_OPTIONS_BY_LEVEL[level];

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qr-furancho-nivel${level}.png"`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/:level/download — descarga el QR
router.get('/:level/download', async (req, res) => {
  const level = parseInt(req.params.level);
  if (![1, 2, 3, 4].includes(level)) {
    return res.status(400).send('Nivel no válido');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/claim?level=${level}`;
  const options = { ...QR_OPTIONS_BY_LEVEL[level], width: 1200 }; // alta resolución para imprimir

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);

    // Guardar en disco también
    const outputDir = path.join(__dirname, '..', 'qr-output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `qr-nivel${level}-${LEVEL_NAMES[level].replace(/ /g, '_')}.png`);
    fs.writeFileSync(filePath, qrBuffer);

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="QR-Furancho-Nivel${level}-${LEVEL_NAMES[level]}.png"`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/all/generate — genera y guarda todos los QRs
router.get('/all/generate', async (req, res) => {
  const outputDir = path.join(__dirname, '..', 'qr-output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const results = [];
  for (let level = 1; level <= 4; level++) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = `${protocol}://${req.get('host')}/claim?level=${level}`;
    const options = { ...QR_OPTIONS_BY_LEVEL[level], width: 1200 };
    try {
      const qrBuffer = await QRCode.toBuffer(claimUrl, options);
      const filePath = path.join(outputDir, `qr-nivel${level}-${LEVEL_NAMES[level].replace(/ /g, '_')}.png`);
      fs.writeFileSync(filePath, qrBuffer);
      results.push({ level, levelName: LEVEL_NAMES[level], url: claimUrl, saved: filePath });
    } catch (e) {
      results.push({ level, error: e.message });
    }
  }

  res.json({ success: true, qrCodes: results });
});

module.exports = router;
