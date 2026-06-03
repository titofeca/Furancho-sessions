const webpush = require('web-push');
const { getAllPushSubscriptions, deletePushSubscription } = require('../db/database');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:furancho@furancho.es', VAPID_PUBLIC, VAPID_PRIVATE);
}

async function sendPushToAll(title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('[Push] VAPID no configurado — notificaciones desactivadas');
    return;
  }
  const subscriptions = getAllPushSubscriptions();
  const payload = JSON.stringify({ title, body, ...data });
  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          deletePushSubscription(sub.endpoint);
        }
        throw err;
      })
    )
  );
  const ok  = results.filter(r => r.status === 'fulfilled').length;
  const err = results.filter(r => r.status === 'rejected').length;
  console.log(`[Push] Enviadas: ${ok} ok, ${err} fallidas de ${subscriptions.length}`);
}

module.exports = { sendPushToAll, VAPID_PUBLIC };
