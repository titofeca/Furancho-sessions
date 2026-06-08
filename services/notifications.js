const nodemailer = require('nodemailer');

// ─── Email ───────────────────────────────────────────────────────────────────

function getMailTransport() {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASSWORD }
  });
}

const VIP_NOTIFY_EMAILS = (process.env.VIP_NOTIFY_EMAILS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);

async function sendVipRequestEmail({ phone, groupSize, notes, eventTitle, eventDate }) {
  const transporter = getMailTransport();
  if (!transporter || VIP_NOTIFY_EMAILS.length === 0) {
    console.log('[VIP Email] No configurado — omitiendo notificación');
    return;
  }

  const subject = `Nueva reserva VIP — ${eventTitle}`;
  const body = `
Se ha recibido una nueva solicitud de reserva VIP en Furancho Sessions.

📅 Evento:     ${eventTitle} (${eventDate})
📞 Teléfono:   ${phone}
👥 Personas:   ${groupSize}
📝 Notas:      ${notes || '—'}

Accede al panel de administración para confirmar o rechazar la reserva.
El cliente recibirá un aviso por WhatsApp automáticamente.
`.trim();

  try {
    await transporter.sendMail({
      from: `"Furancho Sessions" <${process.env.EMAIL_FROM}>`,
      to: VIP_NOTIFY_EMAILS.join(', '),
      subject,
      text: body
    });
    console.log(`[VIP Email] Enviado a ${VIP_NOTIFY_EMAILS.join(', ')}`);
  } catch (e) {
    console.error('[VIP Email] Error:', e.message);
  }
}

async function sendNftApprovalEmail({ mintId, walletAddress, level, levelName, visitCount, adminUrl }) {
  const transporter = getMailTransport();
  if (!transporter || VIP_NOTIFY_EMAILS.length === 0) {
    console.log('[NFT Email] No configurado — omitiendo notificación de aprobación');
    return;
  }

  const walletMasked = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  const subject = `🏅 NFT Nivel ${level} pendiente de aprobar — ${levelName}`;
  const body = `
¡Buah neno, alguien se lo ha ganado!

Un cliente acaba de alcanzar el Nivel ${level} (${levelName}) en Furancho Sessions.

🎴 Nivel:     ${levelName} (Nv${level})
👛 Wallet:    ${walletMasked}
🍷 Visitas:   ${visitCount}
🆔 Mint ID:   #${mintId}

Para aprobar el minteo y que reciba su NFT real en Polygon:
${adminUrl}

Para rechazarlo (error, cuenta duplicada, etc.):
${adminUrl}?reject=${mintId}

Este NFT NO se minteará hasta que lo apruebes.
`.trim();

  try {
    await transporter.sendMail({
      from: `"Furancho Sessions" <${process.env.EMAIL_FROM}>`,
      to: VIP_NOTIFY_EMAILS.join(', '),
      subject,
      text: body
    });
    console.log(`[NFT Email] Notificación de aprobación enviada — Mint #${mintId}`);
  } catch (e) {
    console.error('[NFT Email] Error:', e.message);
  }
}

module.exports = { sendVipRequestEmail, sendNftApprovalEmail };
