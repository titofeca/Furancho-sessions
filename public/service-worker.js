const CACHE_NAME = 'furancho-vip-v87-flow';
const STATIC_ASSETS = [
  '/assets/logo.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-192.png',
  '/assets/icon-maskable-512.png',
  '/assets/cinema.css',
  '/assets/cinema.js',
  '/assets/baixo84.css',
  '/assets/baixo84.js',
  '/assets/baixo84/adega_1984.jpg',
  '/assets/corcho_coin_gold.png',
  '/assets/nft_nivel1_cautivo.jpg',
  '/assets/nft_nivel2_cunqueiro.jpg',
  '/assets/nft_nivel3_larpeiro.jpg',
  '/assets/nft_nivel4_presidente.jpg',
  '/manifest.json',
  '/manifest-admin.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Furancho Sessions';
  const body  = data.body  || '¡Hay novedades en el Furancho!';
  const url   = data.url   || '/claim';

  const options = {
    body,
    icon:  data.icon  || '/assets/icon-192.png',
    badge: data.badge || '/assets/icon-192.png',
    data:  { url },
    vibrate: data.vibrate || [300, 120, 300, 120, 300],
    requireInteraction: data.requireInteraction !== false,
    tag: data.tag || 'furancho',
    renotify: true,
    actions: data.actions || [{ action: 'open', title: 'Abrir 🍷' }],
  };
  if (data.image) options.image = data.image;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/claim';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      const existing = list.find((c) => c.url.includes('/claim'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Ignorar peticiones Range (vídeos .mp4 con 206 Partial Content que rompen cache.put)
  if (event.request.headers.has('range')) return;

  const url = new URL(event.request.url);

  // API y SSE: red directa sin caché
  if (url.pathname.startsWith('/api/')) return;

  // Imágenes, fuentes y estilos estáticos: Stale-While-Revalidate (instantáneo a 60fps en barra)
  const isStaticMedia = /\.(png|jpg|jpeg|webp|svg|woff2?|css|js)$/i.test(url.pathname);
  if (isStaticMedia) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const networkFetch = fetch(event.request)
            .then((res) => {
              if (res && res.status === 200 && res.type === 'basic') {
                cache.put(event.request, res.clone());
              }
              return res;
            })
            .catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Páginas HTML (/claim, /admin, /staff, /entry): Network-First con fallback offline
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
