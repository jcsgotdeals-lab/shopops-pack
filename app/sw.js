// Offline cache: app shell is cached on install; updates take effect on next launch.
const CACHE = 'shopops-pack-v1';
const FILES = ['./', './index.html', './styles.css', './manifest.webmanifest',
  './src/app.js', './src/db.js', './src/code128.js', './src/labels.js', './src/importer.js', './src/feedback.js', './src/camera.js',
  './vendor/pdf-lib.min.js', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // network first so updates arrive when online; cache when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
