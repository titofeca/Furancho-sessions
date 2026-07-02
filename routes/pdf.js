require('dotenv').config();
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const { requireAuth } = require('./admin'); // vista previa del bono solo para admin
const { UPLOADS_DIR } = require('../db/database');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

// Paleta corporativa
const WINE    = '#8B1918';
const GOLD    = '#C4973A';
const CREAM   = '#F2EDE3';
const DARK    = '#1C0E06';
const MUTED   = '#7A6A5A';

// pdfkit usa fuentes WinAnsi (Helvetica): NO sabe pintar emojis ni símbolos fuera
// de Latin-1 (salen como "Ø>ÝB"). Limpiamos el texto antes de escribirlo: pasamos
// comillas/guiones tipográficos a ASCII y quitamos emojis y demás. Los acentos y
// la ñ (≤ 0xFF) se conservan.
function pdfSafe(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x00-\xFF]/g, '')   // fuera emojis y todo lo no Latin-1
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Candidatos de ruta para una imagen /prize-images/... : primero el volumen
// persistente (uploads del admin), luego la versión versionada en el repo.
function imageCandidates(publicUrl) {
  const rel = String(publicUrl).replace(/^\//, '');
  if (rel.startsWith('prize-images/')) {
    const fname = rel.slice('prize-images/'.length);
    return [path.join(UPLOADS_DIR, fname), path.join(__dirname, '..', 'public', 'prize-images', fname)];
  }
  return [path.join(__dirname, '..', 'public', rel)];
}

// pdfkit solo puede incrustar JPEG y PNG (no webp/gif/etc). Devuelve la ruta
// absoluta del fichero si existe y es incrustable; si no, null (y se omite sin
// romper el PDF). Así el logo del local solo se dibuja cuando es válido.
function embeddableImagePath(publicUrl) {
  if (!publicUrl) return null;
  for (const p of imageCandidates(publicUrl)) {
    try {
      if (!fs.existsSync(p)) continue;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      if (isJpeg || isPng) return p;
    } catch (_) { /* siguiente candidato */ }
  }
  return null;
}

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
             prize_details, prize_image, establishment, type,
             validity, people, hours, days, validity_end_date
      FROM raffles WHERE id = ? AND status IN ('accepted','collected')
    `).get(parseInt(req.params.id));

    if (!raffle) return res.status(404).send('Premio no encontrado o no aceptado todavía');

    // Validación de seguridad: debe proveerse la wallet del ganador
    const { wallet } = req.query;
    if (!wallet) return res.status(400).send('Falta la dirección de la wallet');
    if (raffle.winner_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).send('Acceso denegado');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Furancho_Premio_${raffle.id}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Premio Furancho — ${raffle.prize}`, Author: 'Furancho Sessions' } });
    doc.pipe(res);
    buildPremioPdf(doc, raffle, {});
    doc.end();
  } catch(e) { res.status(500).send('Error generando PDF: ' + e.message); }
});

// Dibuja el bono de premio en el documento PDF. Reutilizable para el bono real
// del ganador y para la VISTA PREVIA del admin (código oculto, sin ganador).
// opts.preview: true → cabecera "vista previa", código "••••" y aviso.
function buildPremioPdf(doc, raffle, opts) {
  const preview = !!(opts && opts.preview);
  {
    const W = doc.page.width;
    const H = doc.page.height;

    // ── Fondo crema ─────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(CREAM);

    // ── Banda superior vino ──────────────────────────────────────────────────────
    doc.rect(0, 0, W, 120).fill(WINE);
    doc.rect(0, 120, W, 4).fill(GOLD);

    // ── Logo ─── (fit preserva la proporción real del logo; nunca lo estira) ─────
    try { doc.image(LOGO_PATH, (W - 76) / 2, 22, { fit: [76, 76], align: 'center', valign: 'center' }); } catch(_) {}

    // ── FURANCHO SESSIONS ────────────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('FURANCHO SESSIONS', 0, 130, { align: 'center', characterSpacing: 3 });

    // ── ¡PARABÉNS, GAÑADOR! / VISTA PREVIA ───────────────────────────────────────
    doc.fillColor(WINE).fontSize(13).font('Helvetica-Bold')
       .text(preview ? 'VISTA PREVIA DO BONO' : '¡PARABÉNS, GAÑADOR!', 0, 150, { align: 'center', characterSpacing: 1, width: W });

    // ── Imagen del establecimiento (si existe) ───────────────────────────────────
    let y = 178;
    if (raffle.type === 'local' && raffle.prize_image && embeddableImagePath(raffle.prize_image)) {
      try {
        const imgPath = embeddableImagePath(raffle.prize_image);
        const boxL = 70;   // caja del logo del local
        const fLogo = 54;  // logo Furancho (cuadrado)
        const xW = 22;     // ancho del glifo "×"
        const gap = 14;
        const totalWidth = fLogo + gap + xW + gap + boxL;
        const startX = (W - totalWidth) / 2;

        // Furancho (izquierda), centrado verticalmente respecto a la caja del local
        try { doc.image(LOGO_PATH, startX, y + (boxL - fLogo) / 2, { fit: [fLogo, fLogo], align: 'center', valign: 'center' }); } catch(_) {}

        // "×" en el centro
        doc.fillColor(GOLD).fontSize(20).font('Helvetica-Bold')
           .text('×', startX + fLogo + gap, y + boxL / 2 - 12, { width: xW, align: 'center' });

        // Logo del local (derecha), con marco y proporción preservada (fit)
        const localX = startX + fLogo + gap + xW + gap;
        doc.roundedRect(localX - 4, y - 4, boxL + 8, boxL + 8, 8).fill('#FFFFFF');
        doc.roundedRect(localX - 5, y - 5, boxL + 10, boxL + 10, 9).stroke(GOLD).lineWidth(1);
        doc.image(imgPath, localX, y, { fit: [boxL, boxL], align: 'center', valign: 'center' });

        y += boxL + 22;
      } catch(_) { y += 10; }
    } else if (raffle.prize_image && embeddableImagePath(raffle.prize_image)) {
      try {
        const imgPath = embeddableImagePath(raffle.prize_image);
        const imgSize = 110;
        const imgX = (W - imgSize) / 2;
        doc.roundedRect(imgX - 6, y - 6, imgSize + 12, imgSize + 12, 12).fill('#FFFFFF');
        doc.roundedRect(imgX - 7, y - 7, imgSize + 14, imgSize + 14, 13).stroke(GOLD).lineWidth(1.5);
        // fit preserva la proporción del logo dentro de la caja (no lo deforma)
        doc.image(imgPath, imgX, y, { fit: [imgSize, imgSize], align: 'center', valign: 'center' });
        y += imgSize + 20;
      } catch(_) { y += 10; }
    }

    // ── Establecimiento ──────────────────────────────────────────────────────────
    if (raffle.establishment) {
      doc.fillColor(MUTED).fontSize(10).font('Helvetica-Bold')
         .text(pdfSafe(raffle.establishment).toUpperCase(), 40, y, { align: 'center', width: W - 80, characterSpacing: 2 });
      y += 20;
    }

    // ── Título del premio ────────────────────────────────────────────────────────
    const prizeTxt = pdfSafe(raffle.prize);
    doc.fillColor(DARK).fontSize(28).font('Helvetica-Bold')
       .text(prizeTxt, 40, y, { align: 'center', width: W - 80, lineGap: 4 });
    y += doc.heightOfString(prizeTxt, { width: W - 80, fontSize: 28 }) + 12;

    // ── Descripción del premio ───────────────────────────────────────────────────
    const detailsTxt = pdfSafe(raffle.prize_details);
    if (detailsTxt) {
      doc.fillColor(WINE).fontSize(12).font('Helvetica-Oblique')
         .text(detailsTxt, 60, y, { align: 'center', width: W - 120, lineGap: 4 });
      y += doc.heightOfString(detailsTxt, { width: W - 120, fontSize: 12 }) + 18;
    }

    // ── Condiciones de Validez (si existen) ──────────────────────────────────────
    const endDateStr = raffle.validity_end_date
      ? new Date(raffle.validity_end_date + 'T00:00:00').toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' })
      : null;
    const hasConds = raffle.people || raffle.validity || raffle.days || raffle.hours || endDateStr;
    if (hasConds) {
      let boxHeight = 24;
      if (raffle.people) boxHeight += 16;
      if (raffle.validity) boxHeight += 16;
      if (endDateStr) boxHeight += 16;
      if (raffle.days) boxHeight += 16;
      if (raffle.hours) boxHeight += 16;

      doc.roundedRect(60, y, W - 120, boxHeight, 10).fill('#FFFFFF');
      doc.roundedRect(60, y, W - 120, boxHeight, 10).stroke(GOLD).lineWidth(1);

      doc.fillColor(WINE).fontSize(9).font('Helvetica-Bold')
         .text('CONDICIONES DE VALIDEZ', 75, y + 10, { characterSpacing: 1 });

      let condY = y + 26;
      doc.fillColor(DARK).fontSize(9).font('Helvetica');

      if (raffle.people) {
        doc.font('Helvetica-Bold').text('Personas: ', 75, condY).font('Helvetica').text(pdfSafe(raffle.people), 160, condY);
        condY += 16;
      }
      if (raffle.validity) {
        doc.font('Helvetica-Bold').text('Validez: ', 75, condY).font('Helvetica').text(pdfSafe(raffle.validity), 160, condY);
        condY += 16;
      }
      if (endDateStr) {
        doc.font('Helvetica-Bold').text('Fecha límite: ', 75, condY).font('Helvetica').fillColor(WINE).text(endDateStr, 160, condY);
        doc.fillColor(DARK);
        condY += 16;
      }
      if (raffle.days) {
        doc.font('Helvetica-Bold').text('Días válidos: ', 75, condY).font('Helvetica').text(pdfSafe(raffle.days), 160, condY);
        condY += 16;
      }
      if (raffle.hours) {
        doc.font('Helvetica-Bold').text('Horarios: ', 75, condY).font('Helvetica').text(pdfSafe(raffle.hours), 160, condY);
      }

      y += boxHeight + 18;
    }

    // ── Línea decorativa ─────────────────────────────────────────────────────────
    doc.moveTo(60, y).lineTo(W - 60, y).stroke(GOLD).lineWidth(0.8);
    y += 18;

    // ── Código de verificación ───────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('CÓDIGO DE VERIFICACIÓN', 0, y, { align: 'center', characterSpacing: 2, width: W });
    y += 16;

    doc.roundedRect((W - 140) / 2, y, 140, 52, 10).fill('#FFFFFF').stroke(GOLD).lineWidth(1.5);
    doc.fillColor(preview ? MUTED : WINE).fontSize(36).font('Helvetica-Bold')
       .text(preview ? '••••' : raffle.verification_code, 0, y + 10, { align: 'center', width: W, characterSpacing: 8 });
    y += 70;

    if (preview) {
      doc.fillColor(WINE).fontSize(9).font('Helvetica-Bold')
         .text('El código real solo lo verá el ganador tras el sorteo.', 0, y, { align: 'center', width: W });
      y += 16;
    }

    // ── Fecha ────────────────────────────────────────────────────────────────────
    const fecha = raffle.created_at ? raffle.created_at.slice(0, 10) : '';
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text(preview ? 'Furancho Sessions 2026' : `Sorteo del ${fecha}  ·  Furancho Sessions 2026`, 0, y, { align: 'center', width: W });
    y += 16;

    // ── Ganador (wallet enmascarada, solo bono real) ─────────────────────────────
    if (!preview && raffle.winner_wallet) {
      const wm = raffle.winner_wallet.slice(0, 6) + '…' + raffle.winner_wallet.slice(-4);
      doc.fillColor(MUTED).fontSize(8).font('Helvetica')
         .text('Ganador: ' + wm, 0, y, { align: 'center', width: W });
      y += 14;
    }
    y += 4;

    // ── Estado ───────────────────────────────────────────────────────────────────
    const estadoTxt = preview ? 'VISTA PREVIA — no válido como bono'
      : (raffle.status === 'collected' ? 'Premio entregado' : 'Pendiente de recoger');
    const estadoColor = preview ? GOLD : (raffle.status === 'collected' ? '#22c55e' : WINE);
    doc.fillColor(estadoColor).fontSize(10).font('Helvetica-Bold')
       .text(estadoTxt, 0, y, { align: 'center', width: W });
    y += 24;

    // ── Instrucciones para el LOCAL (este PDF lo envía el admin al local) ─────────
    {
      const instrBody =
        '1. El cliente te enseña este premio en su app (Furancho Sessions › Mis premios).\n' +
        '2. Verás el botón verde "Entregar premio" y el sello "BONO EN VIVO" con la hora en marcha (así compruebas que es la app real y no una captura de pantalla).\n' +
        '3. Pulsa tú ese botón al entregar el premio: el bono queda cerrado y no se puede volver a usar.\n' +
        'Importante: no aceptes capturas de pantalla ni este PDF como canje. El premio SOLO se cierra desde la app del cliente.';
      doc.fontSize(8).font('Helvetica');
      const bodyH = doc.heightOfString(instrBody, { width: W - 150, lineGap: 3 });
      const boxH = 26 + bodyH + 12;
      doc.fillColor('#FBF6EC').roundedRect(60, y, W - 120, boxH, 10).fill();
      doc.roundedRect(60, y, W - 120, boxH, 10).stroke(WINE).lineWidth(1);
      doc.fillColor(WINE).fontSize(9).font('Helvetica-Bold')
         .text('CÓMO CANJEAR EN EL LOCAL', 75, y + 10, { characterSpacing: 1 });
      doc.fillColor(DARK).fontSize(8).font('Helvetica')
         .text(instrBody, 75, y + 26, { width: W - 150, lineGap: 3 });
      y += boxH + 6;
    }

    // ── Footer ───────────────────────────────────────────────────────────────────
    doc.rect(0, H - 42, W, 42).fill(WINE);
    doc.rect(0, H - 46, W, 4).fill(GOLD);
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica').opacity(0.7)
       .text('furancho.sessions  ·  O Bo Viño, A Boa Compaña', 0, H - 26, { align: 'center', characterSpacing: 1 });
    doc.opacity(1);
  }
}

// ─── GET /api/pdf/premio-preview/:id — VISTA PREVIA (admin) del bono de un ──────
// sorteo programado, ANTES de sortear y sin código real.
router.get('/premio-preview/:id', requireAuth, async (req, res) => {
  try {
    const { db } = require('../db/database');
    const s = db.prepare(`SELECT * FROM scheduled_raffles WHERE id = ?`).get(parseInt(req.params.id));
    if (!s) return res.status(404).send('Sorteo no encontrado');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Furancho_Premio_preview_${s.id}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Vista previa — ${s.prize}`, Author: 'Furancho Sessions' } });
    doc.pipe(res);
    buildPremioPdf(doc, s, { preview: true });
    doc.end();
  } catch(e) { res.status(500).send('Error generando PDF: ' + e.message); }
});

// ─── GET /api/pdf/weekly/:week — Bono visual de la chave semanal ──────────────
function sendWeeklyPdfNotice(res, status, { icon, title, message }) {
  res.status(status).send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Chave Semanal · Furancho Sessions</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#F2EDE3;font-family:Arial,sans-serif;color:#1C0E06;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
  .box{background:#fff;border-radius:16px;max-width:380px;padding:32px 24px;box-shadow:0 8px 30px rgba(42,21,9,.1);border:1px solid rgba(139,25,24,.1)}
  .icon{font-size:42px;margin-bottom:12px}
  h1{font-size:18px;color:#8B1918;margin-bottom:10px}
  p{font-size:14px;color:#7A6A5A;line-height:1.5}
</style></head>
<body><div class="box"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p></div></body></html>`);
}

router.get('/weekly/:week', async (req, res) => {
  try {
    const { db } = require('../db/database');
    const raffle = db.prepare(`
      SELECT claimed_week, prize, winner_wallet, verification_code, drawn_at, status, collected_at, confirmed_at, confirm_deadline,
             confirmed_wallets, collected_wallets, forfeited_wallets, forfeited_at
      FROM weekly_raffles WHERE claimed_week = ?
    `).get(req.params.week);

    if (!raffle) {
      return sendWeeklyPdfNotice(res, 404, {
        icon: '🔑', title: 'Premio no encontrado',
        message: 'No encontramos ningún premio de la Chave Semanal para esa semana.'
      });
    }

    // Validación de seguridad: debe proveerse la wallet del ganador
    const { wallet } = req.query;
    if (!wallet) return res.status(400).send('Falta la dirección de la wallet');

    // Gating POR-GANADOR: cada ganador descarga su bono según SU propio estado.
    const { weeklyWinnerState } = require('../db/database');
    const myState = weeklyWinnerState(raffle, wallet);
    if (!myState.matchedWallet) {
      return res.status(403).send('Acceso denegado: esta wallet no es ganadora de la semana');
    }
    if (myState.forfeitedAt) {
      return sendWeeklyPdfNotice(res, 410, {
        icon: '⌛', title: 'Este bono ya no es válido',
        message: 'El plazo para reclamar este premio venció porque no se confirmó a tiempo. Ya no se puede descargar ni usar este bono.'
      });
    }
    if (!(myState.confirmedAt || myState.collectedAt || !raffle.confirm_deadline)) {
      return sendWeeklyPdfNotice(res, 409, {
        icon: '⏳', title: 'Premio aún sin confirmar',
        message: 'Antes de descargar el bono, confirma el premio desde la app dentro del plazo indicado.'
      });
    }

    let isWinner = false;
    let userCode = null; // código individual de ESTE ganador (no el JSON con todos)
    try {
      const wallets = JSON.parse(raffle.winner_wallet);
      const list = Array.isArray(wallets) ? wallets : [wallets];
      const matchWallet = list.find(w => w.toLowerCase() === wallet.toLowerCase());
      if (matchWallet) {
        isWinner = true;
        try {
          const codes = JSON.parse(raffle.verification_code || '{}');
          userCode = (codes && typeof codes === 'object' && !Array.isArray(codes))
            ? codes[matchWallet]
            : raffle.verification_code; // formato antiguo: string simple
        } catch(_) {
          userCode = raffle.verification_code; // formato antiguo: string simple
        }
      }
    } catch (e) {
      isWinner = raffle.winner_wallet.toLowerCase() === wallet.toLowerCase();
      userCode = raffle.verification_code;
    }

    if (!isWinner) {
      return res.status(403).send('Acceso denegado: esta wallet no es ganadora de la semana');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Furancho_Chave_Semanal_${raffle.claimed_week}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Chave Semanal — ${raffle.prize}`, Author: 'Furancho Sessions' } });
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;

    // ── Fondo crema
    doc.rect(0, 0, W, H).fill(CREAM);

    // ── Banda superior vino
    doc.rect(0, 0, W, 120).fill(WINE);
    doc.rect(0, 120, W, 4).fill(GOLD);

    // ── Logo
    try { doc.image(LOGO_PATH, (W - 52) / 2, 10, { width: 52, height: 92 }); } catch(_) {}

    // ── FURANCHO SESSIONS
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('FURANCHO SESSIONS', 0, 130, { align: 'center', characterSpacing: 3 });

    // ── ¡PARABÉNS, GAÑADOR!
    doc.fillColor(WINE).fontSize(13).font('Helvetica-Bold')
       .text('¡PARABÉNS, GAÑADOR DA CHAVE!', 0, 150, { align: 'center', characterSpacing: 1, width: W });

    let y = 178;

    // ── Título del premio
    doc.fillColor(DARK).fontSize(28).font('Helvetica-Bold')
       .text(raffle.prize, 40, y, { align: 'center', width: W - 80, lineGap: 4 });
    y += doc.heightOfString(raffle.prize, { width: W - 80, fontSize: 28 }) + 28;

    // ── Línea decorativa
    doc.moveTo(60, y).lineTo(W - 60, y).stroke(GOLD).lineWidth(0.8);
    y += 28;

    // ── Código de verificación
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text('CÓDIGO DE VERIFICACIÓN', 0, y, { align: 'center', characterSpacing: 2, width: W });
    y += 16;

    doc.roundedRect((W - 140) / 2, y, 140, 52, 10).fill('#FFFFFF').stroke(GOLD).lineWidth(1.5);
    doc.fillColor(WINE).fontSize(36).font('Helvetica-Bold')
       .text(userCode || '—', 0, y + 10, { align: 'center', width: W, characterSpacing: 8 });
    y += 80;

    // ── Fecha
    const fecha = raffle.drawn_at ? raffle.drawn_at.slice(0, 10) : '';
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
       .text(`Chave Semanal ${raffle.claimed_week}  ·  Sorteo del ${fecha}`, 0, y, { align: 'center', width: W });
    y += 20;

    // ── Estado
    const estadoTxt = raffle.collected_at ? 'Premio entregado' : 'Pendiente de recoger';
    const estadoColor = raffle.collected_at ? '#22c55e' : WINE;
    doc.fillColor(estadoColor).fontSize(10).font('Helvetica-Bold')
       .text(estadoTxt, 0, y, { align: 'center', width: W });

    // ── Footer
    doc.rect(0, H - 42, W, 42).fill(WINE);
    doc.rect(0, H - 46, W, 4).fill(GOLD);
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica').opacity(0.7)
       .text('furancho.sessions  ·  O Bo Viño, A Boa Compaña', 0, H - 26, { align: 'center', characterSpacing: 1 });

    doc.end();
  } catch(e) { res.status(500).send('Error generando PDF: ' + e.message); }
});

module.exports = router;
