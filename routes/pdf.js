require('dotenv').config();
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

// Paleta corporativa
const WINE    = '#8B1918';
const GOLD    = '#C4973A';
const CREAM   = '#F2EDE3';
const DARK    = '#1C0E06';
const MUTED   = '#7A6A5A';

// ─── Helper: genera el PDF en el stream de respuesta ─────────────────────────

async function buildQrPdf(res, { filename, qrUrl, qrColor, headline, subheadline, tagline, footerNote }) {
  // Generar QR como buffer PNG
  const qrBuffer = await QRCode.toBuffer(qrUrl, {
    errorCorrectionLevel: 'H',
    type: 'png',
    margin: 2,
    width: 900,
    color: { dark: qrColor, light: '#FFFFFF' }
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: filename.replace('.pdf',''), Author: 'Furancho Sessions' } });
  doc.pipe(res);

  const W = doc.page.width;   // 595.28
  const H = doc.page.height;  // 841.89

  // ── Fondo crema ─────────────────────────────────────────────────────────────
  doc.rect(0, 0, W, H).fill(CREAM);

  // ── Banda superior vino ──────────────────────────────────────────────────────
  doc.rect(0, 0, W, 110).fill(WINE);

  // ── Línea dorada bajo la banda ───────────────────────────────────────────────
  doc.rect(0, 110, W, 4).fill(GOLD);

  // ── Logo (imagen portrait, la mostramos centrada en la banda) ────────────────
  const logoW = 52;
  const logoH = 92;
  const logoX = (W - logoW) / 2;
  try {
    doc.image(LOGO_PATH, logoX, 9, { width: logoW, height: logoH });
  } catch (_) { /* si no está el logo, continuamos */ }

  // ── FURANCHO SESSIONS — texto sobre la banda ─────────────────────────────────
  // (ocultamos si el logo lo cubre bien; lo dejamos como texto invisible accesible)

  // ── Tagline ──────────────────────────────────────────────────────────────────
  doc.fillColor(MUTED)
     .fontSize(9)
     .font('Helvetica')
     .text('FURANCHO SESSIONS', 0, 120, { align: 'center', characterSpacing: 3 });

  // ── Titular principal ────────────────────────────────────────────────────────
  doc.fillColor(DARK)
     .fontSize(32)
     .font('Helvetica-Bold')
     .text(headline, 40, 150, { align: 'center', width: W - 80, lineGap: 4 });

  const headlineHeight = doc.heightOfString(headline, { width: W - 80, fontSize: 32 });
  let y = 150 + headlineHeight + 16;

  // ── Subheadline ──────────────────────────────────────────────────────────────
  if (subheadline) {
    doc.fillColor(WINE)
       .fontSize(13)
       .font('Helvetica-Oblique')
       .text(subheadline, 40, y, { align: 'center', width: W - 80 });
    y += doc.heightOfString(subheadline, { width: W - 80, fontSize: 13 }) + 20;
  }

  // ── QR Code ──────────────────────────────────────────────────────────────────
  const qrSize = 260;
  const qrX = (W - qrSize) / 2;

  // Marco decorativo del QR
  const margin = 12;
  doc.roundedRect(qrX - margin, y - margin, qrSize + margin * 2, qrSize + margin * 2, 14)
     .fill('#FFFFFF');
  doc.roundedRect(qrX - margin - 1.5, y - margin - 1.5, qrSize + margin * 2 + 3, qrSize + margin * 2 + 3, 15)
     .stroke(GOLD).lineWidth(2);

  doc.image(qrBuffer, qrX, y, { width: qrSize, height: qrSize });
  y += qrSize + margin * 2 + 16;

  // ── Tagline del QR ───────────────────────────────────────────────────────────
  doc.fillColor(MUTED)
     .fontSize(10)
     .font('Helvetica')
     .text(tagline, 40, y, { align: 'center', width: W - 80, characterSpacing: 1 });
  y += 30;

  // ── Línea decorativa ─────────────────────────────────────────────────────────
  doc.moveTo(60, y).lineTo(W - 60, y).stroke(GOLD).lineWidth(0.8);
  y += 18;

  // ── Nota al pie ──────────────────────────────────────────────────────────────
  if (footerNote) {
    doc.fillColor(MUTED)
       .fontSize(9)
       .font('Helvetica-Oblique')
       .text(footerNote, 50, y, { align: 'center', width: W - 100, lineGap: 3 });
    y += doc.heightOfString(footerNote, { width: W - 100, fontSize: 9 }) + 14;
  }

  // ── Footer fijo al fondo ──────────────────────────────────────────────────────
  doc.rect(0, H - 42, W, 42).fill(WINE);
  doc.rect(0, H - 46, W, 4).fill(GOLD);

  doc.fillColor('#FFFFFF')
     .fontSize(8)
     .font('Helvetica')
     .opacity(0.7)
     .text('furancho.sessions  ·  O Bo Viño, A Boa Compaña', 0, H - 26, { align: 'center', characterSpacing: 1 });

  doc.end();
}

// ─── GET /api/pdf/entrada — QR de fichar entrada ─────────────────────────────
router.get('/entrada', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.get('host')}/entry`;
  try {
    await buildQrPdf(res, {
      filename: 'Furancho_QR_Entrada.pdf',
      qrUrl: url,
      qrColor: '#116530',
      headline: '¡Cheguei!',
      subheadline: 'Escanea ao entrar ao Furancho',
      tagline: 'FICHA TU ENTRADA · FICHAJE OBLIGATORIO',
      footerNote: 'Escanea este QR nada máis chegar. Sen fichaxe non hai sorteo nin estadísticas de asistencia.\n¡Que non te pille o garda!'
    });
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ─── GET /api/pdf/salida — QR de fichar salida ───────────────────────────────
router.get('/salida', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.get('host')}/claim?checkout=true`;
  try {
    await buildQrPdf(res, {
      filename: 'Furancho_QR_Salida.pdf',
      qrUrl: url,
      qrColor: WINE,
      headline: 'Marcho que teño\nque marchar',
      subheadline: 'Escanea ao saír do Furancho',
      tagline: 'FICHA TU SALIDA · HASTA LA PRÓXIMA',
      footerNote: 'Non te vaias de rondón sen fichar a saída.\nO sistema necesita saber que te foches para calcular o tempo de estadía.\n¡Ata a próxima, que che vaia ben!'
    });
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ─── GET /api/pdf/app — QR de acceso a la app ────────────────────────────────
router.get('/app', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.get('host')}/claim`;
  try {
    await buildQrPdf(res, {
      filename: 'Furancho_QR_App.pdf',
      qrUrl: url,
      qrColor: '#1E3A5F',
      headline: '¿Perdiches\na app?',
      subheadline: 'Non pasa nada, aquí tes o enlace de volta',
      tagline: 'ACCESO A FURANCHO SESSIONS · ESCANEA Y LISTO',
      footerNote: '¿Borraches a app? ¿Cambiaches de móbil? ¿Ou simplemente non lembras onde a deixaches?\nEscanea este QR e volves á túa conta en segundos. Promesa de Furancho.'
    });
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

module.exports = router;
