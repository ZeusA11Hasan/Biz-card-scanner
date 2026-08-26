/* Folio PWA service worker — fast shell, offline fallback, cross-platform */
const SW_VERSION = 'folio-pwa-v10';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const ASSET_CACHE = `${SW_VERSION}-assets`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/script.js',
  '/site.webmanifest',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/maskable-192x192.png',
  '/maskable-512x512.png',
  '/apple-touch-icon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/splash-portrait.png',
];

const ASSET_URLS = [
  '/assets/mascot-idle.svg',
  '/assets/mascot-scanning.svg',
  '/assets/mascot-success.svg',
  '/assets/mascot-chat.svg',
  '/assets/scan-scene.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await shell.addAll(SHELL_URLS);
      const assets = await caches.open(ASSET_CACHE);
      await Promise.all(
        ASSET_URLS.map((url) => assets.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !key.startsWith(SW_VERSION))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isApiRequest(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('execute-api') ||
    url.pathname.includes('/Prod') ||
    url.pathname.includes('/scan') ||
    url.pathname.includes('/contacts') ||
    url.pathname.includes('/profile') ||
    url.pathname.includes('/chat') ||
    url.pathname.includes('/network') ||
    url.pathname.includes('/images/')
  );
}

function isStaticAsset(url) {
  return /\.(?:css|js|png|jpg|jpeg|svg|webp|ico|woff2?|webmanifest)$/i.test(url.pathname);
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  // Respect query strings so ?v= cache-busting works for CSS/JS
  const cached = await cache.match(request, { ignoreSearch: false });
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  return cached || (await networkPromise) || Response.error();
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone());
      cache.put('/', response.clone());
    }
    return response;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      (await cache.match('/offline.html')) ||
      new Response('Offline', { status: 503, statusText: 'Offline' })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Let API calls hit the network (app uses IndexedDB fallback)
  if (isApiRequest(url)) return;

  // Cross-origin (CDNs): try network, optionally cache opaque/success
  if (url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && (response.ok || response.type === 'opaque')) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // HTML navigations — network first for freshness, shell offline
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // App shell files — stale while revalidate for speed + updates
  if (
    url.pathname === '/styles.css' ||
    url.pathname === '/script.js' ||
    url.pathname === '/site.webmanifest' ||
    url.pathname === '/sw.js'
  ) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // Static images / icons — cache first
  if (isStaticAsset(url) || url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});
