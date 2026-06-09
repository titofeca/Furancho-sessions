require('dotenv').config();
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

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
      headline: '¡Ya estoy aquí, ho!',
      subheadline: 'Escanea al entrar al Furancho',
      tagline: 'FICHA TU ENTRADA · FICHAJE OBLIGATORIO, RAPAZ',
      footerNote: 'Escanea este QR nada más llegar, ho. Sin fichar no hay sorteo ni estadísticas de asistencia.\n¡Que no te pille el guardia despistado!'
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
      headline: 'Marcho que me tengo\nque marchar',
      subheadline: 'Escanea al salir del Furancho',
      tagline: 'FICHA TU SALIDA · HASTA LA PRÓXIMA, RAPAZ',
      footerNote: 'No te vayas de tapadillo sin fichar la salida, ho.\nEl sistema necesita saber que te has ido para calcular tu tiempo de estancia.\n¡Hasta la próxima, que te vaya bien y no tardes mucho!'
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
      headline: '¿Perdiste\nla app, ho?',
      subheadline: 'No pasa nada, aquí tienes el enlace de vuelta',
      tagline: 'ACCESO A FURANCHO SESSIONS · ESCANEA Y LISTO',
      footerNote: '¿Borraste la app? ¿Cambiaste de móvil? ¿O simplemente no recuerdas dónde la dejaste?\nEscanea este QR y vuelves a tu cuenta en segundos, ho. Promesa de furancheiro.'
    });
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ─── GET /api/pdf/vip — Cartel zona VIP para imprimir en A4 ─────────────────
router.get('/vip', async (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Furancho_VIP_Zone.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Furancho VIP Zone', Author: 'Furancho Sessions' } });
  doc.pipe(res);

  const W = doc.page.width;   // 595.28
  const H = doc.page.height;  // 841.89

  // ── Fondo oscuro total ───────────────────────────────────────────────────────
  doc.rect(0, 0, W, H).fill(DARK);

  // ── Textura: líneas diagonales sutiles ──────────────────────────────────────
  doc.save();
  doc.opacity(0.04);
  for (let i = -H; i < W + H; i += 18) {
    doc.moveTo(i, 0).lineTo(i + H, H).stroke('#C4973A').lineWidth(1);
  }
  doc.restore();

  // ── Marco exterior dorado ────────────────────────────────────────────────────
  doc.rect(18, 18, W - 36, H - 36).stroke(GOLD).lineWidth(2).opacity(1);
  doc.rect(24, 24, W - 48, H - 48).stroke(GOLD).lineWidth(0.5).opacity(0.4);

  // ── Banda superior vino ──────────────────────────────────────────────────────
  doc.opacity(1);
  doc.rect(18, 18, W - 36, 130).fill(WINE);

  // ── Logo centrado en la banda ────────────────────────────────────────────────
  const logoW = 58;
  const logoH = 103;
  try {
    doc.image(LOGO_PATH, (W - logoW) / 2, 23, { width: logoW, height: logoH });
  } catch (_) {}

  // ── "FURANCHO SESSIONS" debajo del logo ──────────────────────────────────────
  doc.fillColor(GOLD)
     .fontSize(8)
     .font('Helvetica-Bold')
     .opacity(0.9)
     .text('FURANCHO SESSIONS', 0, 133, { align: 'center', characterSpacing: 4 });

  // ── Línea dorada separadora ──────────────────────────────────────────────────
  doc.opacity(1);
  doc.moveTo(60, 152).lineTo(W - 60, 152).stroke(GOLD).lineWidth(1);

  // ── ⚠ ACCESO RESTRINGIDO ─────────────────────────────────────────────────────
  doc.fillColor(GOLD)
     .fontSize(11)
     .font('Helvetica-Bold')
     .opacity(0.85)
     .text('⚠  A C C E S O   R E S T R I N G I D O  ⚠', 0, 164, { align: 'center', characterSpacing: 2 });

  // ── VIP (gigante, decorativo) ─────────────────────────────────────────────────
  doc.fillColor(WINE)
     .fontSize(180)
     .font('Helvetica-Bold')
     .opacity(0.12)
     .text('VIP', 0, 195, { align: 'center', width: W });

  // ── VIP real encima ───────────────────────────────────────────────────────────
  doc.fillColor('#FFFFFF')
     .fontSize(110)
     .font('Helvetica-Bold')
     .opacity(1)
     .text('VIP', 0, 215, { align: 'center', width: W, characterSpacing: 12 });

  // ── FURANCHO ZONE ────────────────────────────────────────────────────────────
  doc.fillColor(GOLD)
     .fontSize(28)
     .font('Helvetica-Bold')
     .opacity(1)
     .text('FURANCHO  ZONE', 0, 348, { align: 'center', width: W, characterSpacing: 6 });

  // ── Línea dorada central ──────────────────────────────────────────────────────
  doc.moveTo(80, 394).lineTo(W - 80, 394).stroke(GOLD).lineWidth(0.8);

  // ── Texto divertido ───────────────────────────────────────────────────────────
  doc.fillColor('#FFFFFF')
     .fontSize(13.5)
     .font('Helvetica-Bold')
     .opacity(0.95)
     .text('Se lles dixeron que é por aquí, é por aquí.', 0, 408, { align: 'center', width: W });

  doc.fillColor(GOLD)
     .fontSize(11)
     .font('Helvetica-Oblique')
     .opacity(0.8)
     .text('Se non lles dixeron nada... xa están tardando en irse.', 0, 430, { align: 'center', width: W });

  // ── Separador ─────────────────────────────────────────────────────────────────
  doc.moveTo(120, 460).lineTo(W - 120, 460).stroke(WINE).lineWidth(0.6).opacity(0.6);

  // ── Condiciones de acceso ─────────────────────────────────────────────────────
  doc.opacity(1);
  const rules = [
    { icon: '✦', text: 'Reserva VIP confirmada por el staff' },
    { icon: '✦', text: 'Actitud de persona interesante (mínimo)' },
    { icon: '✦', text: 'Respeto al espacio y a los demás' },
    { icon: '✦', text: 'Las normas las pone el Furancho. Siempre.' },
  ];

  let ry = 474;
  for (const r of rules) {
    doc.fillColor(GOLD).fontSize(9).font('Helvetica-Bold').opacity(0.9)
       .text(r.icon, 100, ry, { width: 16, align: 'left' });
    doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica').opacity(0.75)
       .text(r.text, 120, ry, { width: W - 240, align: 'left' });
    ry += 18;
  }

  // ── Línea inferior decorativa ─────────────────────────────────────────────────
  doc.moveTo(60, ry + 12).lineTo(W - 60, ry + 12).stroke(GOLD).lineWidth(1).opacity(1);

  // ── Tagline final ─────────────────────────────────────────────────────────────
  doc.fillColor(GOLD)
     .fontSize(10)
     .font('Helvetica-Bold')
     .opacity(0.7)
     .text('O Bo Viño · A Boa Compaña · A Boa Xente', 0, ry + 26, { align: 'center', characterSpacing: 2, width: W });

  // ── Footer banda vino ─────────────────────────────────────────────────────────
  doc.rect(18, H - 60, W - 36, 42).fill(WINE).opacity(1);
  doc.fillColor('#FFFFFF')
     .fontSize(8)
     .font('Helvetica')
     .opacity(0.6)
     .text('furancho.sessions  ·  Imprime · Plastifica · Coloca  ·  Job done.', 0, H - 44, { align: 'center', characterSpacing: 1, width: W });

  doc.end();
});

// ─── GET /api/pdf/premio/:id — Bono visual del premio ganado ─────────────────
router.get('/premio/:id', async (req, res) => {
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`
      SELECT id, prize, winner_wallet, verification_code, created_at, status,
             prize_details, prize_image, establishment
      FROM raffles WHERE id = ? AND status IN ('accepted','collected')
    `).get(parseInt(req.params.id));

    if (!raffle) return res.status(404).send('Premio no encontrado o no aceptado todavía');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Furancho_Premio_${raffle.id}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Premio Furancho — ${raffle.prize}`, Author: 'Furancho Sessions' } });
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;

    // ── Fondo crema ─────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(CREAM);

    // ── Banda superior vino ──────────────────────────────────────────────────────
    doc.rect(0, 0, W, 120).fill(WINE);
    doc.rect(0, 120, W, 4).fill(GOLD);

    // ── Logo ─────────────────────────────────────────────────────────────────────
    try { doc.image(LOGO_PATH, (W - 52) / 2, 10, { width: 52, height: 92 }); } catch(_) {}

    // ── FURANCHO SESSIONS ────────────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('FURANCHO SESSIONS', 0, 130, { align: 'center', characterSpacing: 3 });

    // ── 🎉 GANADOR ───────────────────────────────────────────────────────────────
    doc.fillColor(WINE).fontSize(13).font('Helvetica-Bold')
       .text('🎉 ¡PARABÉNS, GAÑADOR!', 0, 150, { align: 'center', characterSpacing: 1, width: W });

    // ── Imagen del establecimiento (si existe) ───────────────────────────────────
    let y = 178;
    if (raffle.prize_image) {
      try {
        const imgPath = path.join(__dirname, '..', 'public', raffle.prize_image.replace(/^\//, ''));
        if (fs.existsSync(imgPath)) {
          const imgSize = 110;
          const imgX = (W - imgSize) / 2;
          doc.roundedRect(imgX - 6, y - 6, imgSize + 12, imgSize + 12, 12).fill('#FFFFFF');
          doc.roundedRect(imgX - 7, y - 7, imgSize + 14, imgSize + 14, 13).stroke(GOLD).lineWidth(1.5);
          doc.image(imgPath, imgX, y, { width: imgSize, height: imgSize, fit: [imgSize, imgSize] });
          y += imgSize + 20;
        }
      } catch(_) { y += 10; }
    }

    // ── Establecimiento ──────────────────────────────────────────────────────────
    if (raffle.establishment) {
      doc.fillColor(MUTED).fontSize(10).font('Helvetica-Bold')
         .text(raffle.establishment.toUpperCase(), 40, y, { align: 'center', width: W - 80, characterSpacing: 2 });
      y += 20;
    }

    // ── Título del premio ────────────────────────────────────────────────────────
    doc.fillColor(DARK).fontSize(28).font('Helvetica-Bold')
       .text(raffle.prize, 40, y, { align: 'center', width: W - 80, lineGap: 4 });
    y += doc.heightOfString(raffle.prize, { width: W - 80, fontSize: 28 }) + 12;

    // ── Descripción del premio ───────────────────────────────────────────────────
    if (raffle.prize_details) {
      doc.fillColor(WINE).fontSize(12).font('Helvetica-Oblique')
         .text(raffle.prize_details, 60, y, { align: 'center', width: W - 120, lineGap: 4 });
      y += doc.heightOfString(raffle.prize_details, { width: W - 120, fontSize: 12 }) + 18;
    }

    // ── Línea decorativa ─────────────────────────────────────────────────────────
    doc.moveTo(60, y).lineTo(W - 60, y).stroke(GOLD).lineWidth(0.8);
    y += 18;

    // ── Código de verificación ───────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('CÓDIGO DE VERIFICACIÓN', 0, y, { align: 'center', characterSpacing: 2, width: W });
    y += 16;

    doc.roundedRect((W - 140) / 2, y, 140, 52, 10).fill('#FFFFFF').stroke(GOLD).lineWidth(1.5);
    doc.fillColor(WINE).fontSize(36).font('Helvetica-Bold')
       .text(raffle.verification_code, 0, y + 10, { align: 'center', width: W, characterSpacing: 8 });
    y += 70;

    // ── Fecha ────────────────────────────────────────────────────────────────────
    const fecha = raffle.created_at ? raffle.created_at.slice(0, 10) : '';
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text(`Sorteo del ${fecha}  ·  Furancho Sessions 2026`, 0, y, { align: 'center', width: W });
    y += 20;

    // ── Estado ───────────────────────────────────────────────────────────────────
    const estadoTxt = raffle.status === 'collected' ? '✅ Premio entregado' : '⏳ Pendiente de recoger';
    const estadoColor = raffle.status === 'collected' ? '#22c55e' : WINE;
    doc.fillColor(estadoColor).fontSize(10).font('Helvetica-Bold')
       .text(estadoTxt, 0, y, { align: 'center', width: W });

    // ── Footer ───────────────────────────────────────────────────────────────────
    doc.rect(0, H - 42, W, 42).fill(WINE);
    doc.rect(0, H - 46, W, 4).fill(GOLD);
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica').opacity(0.7)
       .text('furancho.sessions  ·  O Bo Viño, A Boa Compaña', 0, H - 26, { align: 'center', characterSpacing: 1 });

    doc.end();
  } catch(e) { res.status(500).send('Error generando PDF: ' + e.message); }
});

module.exports = router;
