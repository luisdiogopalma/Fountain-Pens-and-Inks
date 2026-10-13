// Offline support: app files are served from cache and refreshed in the background.
const CACHE = 'fountain-pens-and-inks-v8';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'seed.json', 'manifest.webmanifest', 'js/app.js', 'js/db.js', 'js/drive.js', 'js/editor.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = u.origin === location.origin;
  const lib = u.hostname === 'cdnjs.cloudflare.com';
  if (!own && !lib) return; // Google APIs etc. always go to the network
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: own });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
