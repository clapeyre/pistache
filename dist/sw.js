const CACHE = 'pistache-shell-v9-pi-demo-20261013';
const SHELL = [
  '/', '/index.html', '/setup.html', '/setup.js?v=20261007-tailscale', '/recorder.html',
  '/recorder.js?v=20261008-recorder', '/recorder.css', '/legacy-styles.css', '/styles.css?v=pistache-20261013',
  '/app.js?v=pistache-20261013', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('pistache-shell-') && key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && ['/', '/index.html', '/setup.html', '/recorder.html'].includes(url.pathname)) {
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(key, response.clone()));
      return response;
    }).catch(() => caches.match(key).then((hit) => hit || Response.error())));
    return;
  }
  if (SHELL.includes(url.pathname + url.search)) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then((hit) => hit || Response.error())));
  }
});
