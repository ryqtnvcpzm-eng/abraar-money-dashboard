// Service worker: makes Money open offline. Caches only this site's own files.
// The encrypted vault is fetched network-first so new statements show up, with the cached copy as fallback.
// Bump VERSION whenever app files change.
const VERSION = 'money-v1.0.1';
const SHELL = [
  './', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/state.js', 'js/format.js', 'js/crypto.js', 'js/store.js', 'js/ui.js', 'js/charts.js',
  'js/categorize.js', 'js/cibc-parser.js', 'js/ledger.js', 'js/pdf-text.js', 'js/demo.js',
  'js/views/overview.js', 'js/views/spending.js', 'js/views/activity.js', 'js/views/plan.js',
  'js/views/sheets.js', 'js/views/importer.js', 'js/views/settings.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'data/rules.json', 'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const NETWORK_FIRST = [/\/data\/vault\.enc\.json/, /\/data\/rules\.json/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch api.github.com etc.

  if (NETWORK_FIRST.some((r) => r.test(url.pathname))) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const key = url.origin + url.pathname; // ignore cache-busting query
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch {
        return (await cache.match(key)) || new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // App shell: cache first, refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
    const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic' && !res.redirected) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
