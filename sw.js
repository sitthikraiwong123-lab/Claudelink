/* Service worker for the Schmoll Export/Warranty app.
 * The app shell (Warranty App.html) is fully self-contained: jsPDF, html2canvas and
 * the Sarabun font are all inlined, so caching the few static files below is
 * enough to run completely offline. Lookup/sync calls to Google Apps Script
 * are always fetched from the network (never cached) so data stays fresh. */
const CACHE = 'schmoll-export-v3';
const SHELL = [
  './',
  './Warranty%20App.html',
  './manifest.json',
  './icon-192.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache the Apps Script backend — always hit the network for live data.
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) {
    return;
  }

  // The HTML document (navigations + Warranty App.html) uses NETWORK-FIRST so a
  // redeployed app is picked up immediately when online, falling back to the
  // cached copy offline. Without this, cache-first would keep serving a stale
  // document after every edit until the cache version is bumped.
  const isDocument = req.mode === 'navigate' ||
    (url.origin === self.location.origin && /(^\/$|\/Warranty%20App\.html$)/.test(url.pathname));

  if (isDocument) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./Warranty%20App.html', copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./Warranty%20App.html')))
    );
    return;
  }

  // Everything else (icon, manifest, static assets): cache-first with a
  // background refresh, since those rarely change.
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
    })
  );
});
