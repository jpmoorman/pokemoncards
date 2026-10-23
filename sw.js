// Offline support for the app shell. Network first so updates show up right away;
// falls back to the cached copy when offline. API data is cached by the app itself.
const CACHE = 'card-scanner-v3';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'css/batch.css', 'css/trade.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/api.js', 'js/batch.js', 'js/catalog.js', 'js/collection.js', 'js/components.js', 'js/detect.js', 'js/entry.js', 'js/fx.js',
  'js/identify.js', 'js/match.js', 'js/ocr.js', 'js/parse.js', 'js/prices.js', 'js/sheet.js', 'js/stamps.js', 'js/trade.js', 'js/ui.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
