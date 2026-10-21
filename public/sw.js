const SHELL = 'porch-shell-v1';
const PRECACHE = ['/offline', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/phone') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));

    return;
  }

  if (url.pathname.startsWith('/app/assets/')) {
    event.respondWith(caches.open(SHELL).then(async (cache) => (await cache.match(request)) ?? fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());

      return response;
    })));
  }
});
