const webpush = require('web-push');
const { getAllPushSubscriptions, deletePushSubscription } = require('../db/database');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:furancho@furancho.es', VAPID_PUBLIC, VAPID_PRIVATE);
}

function logPushAttempt(title, body, target, success, failure, total, error = null) {
  try {
    const { db } = require('../db/database');
    db.prepare(`
      INSERT INTO push_logs (title, body, target, success_count, failure_count, total_count, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, body, target, success, failure, total, error);
  } catch (e) {
    console.error('[Push] Error guardando log en base de datos:', e.message);
  }
}

async function sendPushToAll(title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('[Push] VAPID no configurado — notificaciones desactivadas');
    logPushAttempt(title, body, 'all', 0, 0, 0, 'VAPID no configurado');
    return;
  }
  const subscriptions = getAllPushSubscriptions();
  if (!subscriptions.length) {
    logPushAttempt(title, body, 'all', 0, 0, 0, 'Sin suscripciones');
    return;
  }
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

  let errMsg = null;
  if (err > 0) {
    const failed = results.filter(r => r.status === 'rejected');
    errMsg = `${err} envíos fallidos. Primer error: ${failed[0]?.reason?.message || failed[0]?.reason || 'Desconocido'}`;
  }
  logPushAttempt(title, body, 'all', ok, err, subscriptions.length, errMsg);
}

async function sendPushToWallet(walletAddress, title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    logPushAttempt(title, body, walletAddress, 0, 0, 0, 'VAPID no configurado');
    return;
  }
  const subscriptions = getAllPushSubscriptions().filter(sub => sub.wallet_address && sub.wallet_address.toLowerCase() === walletAddress.toLowerCase());
  if (!subscriptions.length) {
    logPushAttempt(title, body, walletAddress, 0, 0, 0, 'Sin suscripciones para esta wallet');
    return;
  }
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
  let errMsg = null;
  if (err > 0) {
    const failed = results.filter(r => r.status === 'rejected');
    errMsg = `${err} envíos fallidos. Primer error: ${failed[0]?.reason?.message || failed[0]?.reason || 'Desconocido'}`;
  }
  logPushAttempt(title, body, walletAddress, ok, err, subscriptions.length, errMsg);
}

// Envía push solo a un conjunto concreto de wallets (p.ej. los que ficharon entrada esta noche)
async function sendPushToWallets(walletAddresses, title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    logPushAttempt(title, body, 'list', 0, 0, 0, 'VAPID no configurado');
    return;
  }
  const set = new Set((walletAddresses || []).map(w => w.toLowerCase()));
  if (!set.size) {
    logPushAttempt(title, body, 'list', 0, 0, 0, 'Lista de wallets vacía');
    return;
  }
  const subscriptions = getAllPushSubscriptions().filter(sub => sub.wallet_address && set.has(sub.wallet_address.toLowerCase()));
  if (!subscriptions.length) {
    logPushAttempt(title, body, `list (${set.size} wallets)`, 0, 0, 0, 'Sin suscripciones para estas wallets');
    return;
  }
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
  let errMsg = null;
  if (err > 0) {
    const failed = results.filter(r => r.status === 'rejected');
    errMsg = `${err} envíos fallidos. Primer error: ${failed[0]?.reason?.message || failed[0]?.reason || 'Desconocido'}`;
  }
  logPushAttempt(title, body, `list (${set.size} wallets)`, ok, err, subscriptions.length, errMsg);
}

async function sendPushToChannel(channel, title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    logPushAttempt(title, body, `channel:${channel}`, 0, 0, 0, 'VAPID no configurado');
    return;
  }
  const subscriptions = getAllPushSubscriptions().filter(sub => {
    if (!sub.channels) return channel === 'general';
    const list = sub.channels.split(',').map(x => x.trim().toLowerCase());
    return list.includes(channel.toLowerCase());
  });

  if (!subscriptions.length) {
    logPushAttempt(title, body, `channel:${channel}`, 0, 0, 0, 'Sin suscripciones en este canal');
    return;
  }

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
  let errMsg = null;
  if (err > 0) {
    const failed = results.filter(r => r.status === 'rejected');
    errMsg = `${err} envíos fallidos. Primer error: ${failed[0]?.reason?.message || failed[0]?.reason || 'Desconocido'}`;
  }
  logPushAttempt(title, body, `channel:${channel}`, ok, err, subscriptions.length, errMsg);
  console.log(`[Push Channel:${channel}] Enviadas: ${ok} ok, ${err} fallidas de ${subscriptions.length}`);
}

module.exports = { sendPushToAll, sendPushToWallet, sendPushToWallets, sendPushToChannel, VAPID_PUBLIC };
