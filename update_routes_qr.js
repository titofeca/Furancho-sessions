const fs = require('fs');
const path = './routes/qr.js';
let content = fs.readFileSync(path, 'utf8');

// 1. Crear el endpoint GET /api/qr/entry
const entryQrRoute = `
// GET /api/qr/entry — genera QR de entrada (Fichaje Inicial)
router.get('/entry', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = \`\${protocol}://\${req.get('host')}/entry\`;
  const options = { ...QR_OPTIONS, color: { dark: '#116530', light: '#FAFAFA' } }; // Verde

  try {
    const qrBuffer = await QRCode.toBuffer(claimUrl, options);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', \`inline; filename="qr-furancho-entry.png"\`);
    res.send(qrBuffer);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// GET /api/qr/entry/download
router.get('/entry/download', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const claimUrl = \`\${protocol}://\${req.get('host')}/entry\`;
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
`;

content = content.replace("// GET /api/qr/checkin", entryQrRoute + "\n// GET /api/qr/checkin");

// 2. Modificar el color del QR de salida (checkin actual) para que sea rojo o distinto
content = content.replace("color: { dark: '#1E3A5F', light: '#FAFAFA' }", "color: { dark: '#8B0000', light: '#FAFAFA' }");
content = content.replace("color: { dark: '#1E3A5F', light: '#FAFAFA' }", "color: { dark: '#8B0000', light: '#FAFAFA' }");
content = content.replace("'QR_Furancho_Checkin.png'", "'QR_Salida_Furancho.png'");

fs.writeFileSync(path, content);
console.log('QR routes updated');
