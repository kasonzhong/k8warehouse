const CACHE_NAME = 'k8-tencent-api-phone-camera-v12';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js?v=12.0.0',
  './jszip.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Supabase connection settings must never be served from an old cache.
  if (url.pathname.endsWith('/supabase-config.js')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() =>
        new Response(
          "window.K8_SUPABASE_CONFIG = null;",
          { headers: { 'Content-Type': 'application/javascript' } }
        )
      )
    );
    return;
  }

  // Service worker itself and HTML should prefer the network so updates appear quickly.
  if (
    url.pathname.endsWith('/service-worker.js') ||
    url.pathname === '/' ||
    url.pathname.endsWith('/index.html')
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Other static assets remain cache-first for offline use.
  event.respondWith(
    caches.match(event.request).then(cached =>
      cached ||
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
    )
  );
});
