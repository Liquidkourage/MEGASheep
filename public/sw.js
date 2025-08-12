/* MEGASheep lightweight Service Worker for display stability */
const VERSION = 'ms-v3';
const CORE_CACHE = `core-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// Core assets to precache (kept small)
// Do NOT precache '/': always fetch index/network-first to avoid stale host/player UIs
const CORE_ASSETS = [
  '/styles.css',
  '/display.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![CORE_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Helper: clone and cache a response safely
async function putRuntime(request, response) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    // Only cache successful (200) basic or opaque responses
    if (response && (response.status === 200 || response.type === 'opaque')) {
      await cache.put(request, response.clone());
    }
  } catch (_) {}
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin resources
  if (url.origin !== location.origin) return;

  // Always network-first for navigations/HTML to prevent stale pages
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for uploaded images used as backgrounds
  if (request.destination === 'image' && url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          // Revalidate in background
          event.waitUntil(fetch(request).then((res) => putRuntime(request, res)).catch(() => {}));
          return cached;
        }
        return fetch(request)
          .then((res) => {
            event.waitUntil(putRuntime(request, res));
            return res.clone();
          })
          .catch(() => cached || Response.error());
      })
    );
    return;
  }

  // Network-first for sheep URL list to keep it fresh, fallback to cache if offline
  if (url.pathname === '/api/sheep-urls') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          event.waitUntil(putRuntime(request, res));
          return res.clone();
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Default: try cache, then network
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});


