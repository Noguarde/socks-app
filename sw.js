const CACHE = 'socks-app-v1';
const ASSETS = ['.', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache the live sheet fetch or hotlinked sock images — always go to network.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
