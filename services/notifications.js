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

module.exports = { sendVipRequestEmail };
