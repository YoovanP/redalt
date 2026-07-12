const CACHE_VERSION = 'redalt-v5';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const API_CACHE = `${CACHE_VERSION}-api`;
const APP_SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg'];
const MAX_ASSET_ENTRIES = 60;
const MAX_API_ENTRIES = 40;
const API_MAX_AGE_MS = 30 * 60 * 1000;

function isHttpGet(request) {
  if (!request || request.method !== 'GET') {
    return false;
  }

  const protocol = new URL(request.url).protocol;
  return protocol === 'http:' || protocol === 'https:';
}

function isSuccessfulResponse(response) {
  return response && response.ok;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;

  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
}

async function storeAsset(request, response) {
  if (!isHttpGet(request) || !isSuccessfulResponse(response)) {
    return;
  }

  const cache = await caches.open(ASSET_CACHE);
  await cache.put(request, response.clone());
  await trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES);
}

async function storeApiResponse(request, response) {
  const contentType = (response?.headers.get('content-type') ?? '').toLowerCase();

  if (!isHttpGet(request) || !isSuccessfulResponse(response) || !contentType.includes('application/json')) {
    return;
  }

  const headers = new Headers(response.headers);
  headers.set('x-redalt-cache-time', String(Date.now()));
  const cachedResponse = new Response(await response.clone().blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const cache = await caches.open(API_CACHE);
  await cache.put(request, cachedResponse);
  await trimCache(API_CACHE, MAX_API_ENTRIES);
}

async function readFreshApiResponse(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  if (!cached) {
    return null;
  }

  const cachedAt = Number(cached.headers.get('x-redalt-cache-time') ?? '0');

  if (!Number.isFinite(cachedAt) || cachedAt <= 0 || Date.now() - cachedAt > API_MAX_AGE_MS) {
    await cache.delete(request);
    return null;
  }

  return cached;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('redalt-') && !key.startsWith(CACHE_VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (!isHttpGet(request)) {
    return;
  }

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const fallback = (await caches.match('/index.html')) ?? (await caches.match('/'));
        return fallback ?? new Response('Offline', { status: 503 });
      }),
    );
    return;
  }

  if (url.pathname === '/api/reddit' || url.pathname.startsWith('/api/reddit/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          event.waitUntil(storeApiResponse(request, response));
          return response;
        })
        .catch(async () => {
          const cached = await readFreshApiResponse(request);
          return cached ?? new Response('Offline and no recent Reddit response is cached.', { status: 503 });
        }),
    );
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isStaticAsset = ['script', 'style', 'font', 'image', 'manifest'].includes(request.destination);

  if (!isSameOrigin || !isStaticAsset || request.headers.has('range')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        event.waitUntil(storeAsset(request, response));
        return response;
      });
    }),
  );
});
