// Gaucho Pass service worker: lets the app open offline, so a student's ID
// still shows its code without a connection.
//
// Strategy: when online, always fetch the newest files (so an update can never
// leave old and new code mixed together); when offline or slow, use the copy
// saved on this device. Everything the page needs is on this site, and calls to
// Supabase are never cached.

const VERSION = 'gaucho-pass-v2.0.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/fonts.css',
  'fonts/bricolage-grotesque-latin.woff2', 'fonts/jetbrains-mono-latin.woff2', 'fonts/public-sans-latin.woff2',
  'js/app.js', 'js/api.js', 'js/config.js', 'js/ui.js', 'js/totp.js', 'js/keystore.js', 'js/feedback.js',
  'js/reasons.js', 'js/result.js', 'js/student.js', 'js/scanner.js', 'js/admin.js', 'js/demo.js', 'js/guest.js',
  'vendor/supabase.js', 'vendor/qrcode.js', 'vendor/jsQR.js',
  'avatars/jordan.svg', 'avatars/priya.svg', 'avatars/theo.svg', 'avatars/lena.svg',
  'avatars/sam.svg', 'avatars/maya.svg', 'avatars/dev.svg', 'avatars/aiko.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon.png',
];
const NETWORK_TIMEOUT_MS = 3000;

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

function fromNetwork(req, cacheKey) {
  return fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(cacheKey, copy));
    }
    return res;
  });
}

function networkFirst(req, cacheKey) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const useCache = () => caches.match(cacheKey).then((hit) => {
      if (settled) return;
      if (hit) { settled = true; resolve(hit); }
    });
    const timer = setTimeout(useCache, NETWORK_TIMEOUT_MS);
    fromNetwork(req, cacheKey).then((res) => {
      clearTimeout(timer);
      if (settled) return;
      if (res.ok) { settled = true; resolve(res); return; }
      caches.match(cacheKey).then((hit) => { if (!settled) { settled = true; resolve(hit || res); } });
    }).catch(() => {
      clearTimeout(timer);
      caches.match(cacheKey).then((hit) => {
        if (settled) return;
        settled = true;
        if (hit) resolve(hit); else reject(new TypeError('offline and not saved'));
      });
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // The app page is saved under one name, whatever follows the "?" or "#".
    const scope = new URL(self.registration.scope).pathname;
    const isAppPage = req.mode === 'navigate' && (url.pathname === scope || url.pathname === scope + 'index.html');
    e.respondWith(networkFirst(req, isAppPage ? 'index.html' : req));
    return;
  }

  // Everything else (Supabase): straight to the network, never cached.
});
