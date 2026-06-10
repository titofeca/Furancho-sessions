const CACHE_NAME = 'furancho-vip-v52';
const ASSETS_TO_CACHE = [
  '/claim',
  '/entry',
  '/admin',
  '/assets/logo.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-192.png',
  '/assets/icon-maskable-512.png',
  '/assets/nft_nivel1_cautivo.jpg',
  '/assets/nft_nivel2_cunqueiro.jpg',
  '/assets/nft_nivel3_larpeiro.jpg',
  '/assets/nft_nivel4_presidente.jpg',
  '/manifest.json',
  '/manifest-admin.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Furancho Sessions';
  const body  = data.body  || '¡Hay novedades en el Furancho!';
  const url   = data.url   || '/claim';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data:  { url },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/claim';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const existing = list.find(c => c.url.includes('/claim'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // API calls: red primero, sin cache
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Assets y páginas: red primero, cache como fallback
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
