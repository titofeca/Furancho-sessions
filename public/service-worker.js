const CACHE_NAME = 'furancho-vip-v1';
const ASSETS_TO_CACHE = [
  '/claim',
  '/assets/logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('fetch', (event) => {
  // Solo cacheamos GET requests (para que la app abra offline)
  // pero intentamos usar la red primero si hay conexión.
  if (event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
