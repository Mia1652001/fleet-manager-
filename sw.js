// Fleet Manager service worker.
//
// Caching strategy, deliberately chosen:
//   * Our own files (HTML/CSS/JS)  -> network first, cache as fallback.
//     This means a fresh upload is always picked up straight away, and the
//     app still opens when there's no connection.
//   * Third-party libraries and fonts (gstatic / Google Fonts) -> cache first.
//     These are the big, slow downloads and they almost never change, so
//     serving them from the device is where the speed gain comes from.
//   * Firebase data traffic (firestore/identitytoolkit) -> never cached.
//     Live data must always come from the network.
//
// Bump CACHE_VERSION whenever you want every device to discard its cache.

const CACHE_VERSION = "fleet-v1";
const APP_CACHE = `${CACHE_VERSION}-app`;
const LIB_CACHE = `${CACHE_VERSION}-lib`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./bookings.html",
  "./customers.html",
  "./billing.html",
  "./maintenance.html",
  "./style.css",
  "./firebase-init.js",
  "./fleet.js",
  "./bookings.js",
  "./customers.js",
  "./billing.js",
  "./maintenance.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Hosts whose responses we cache aggressively (libraries and fonts)
const LIB_HOSTS = [
  "www.gstatic.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
];

// Hosts we must never cache (live data and auth)
const NEVER_CACHE = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install if one file 404s
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Never touch live data or auth traffic
  if (NEVER_CACHE.some(h => url.hostname.includes(h))) return;

  // Libraries and fonts: cache first, refresh in background
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(LIB_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        const network = fetch(req).then(res => {
          if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        return hit || network || fetch(req);
      })
    );
    return;
  }

  // Our own files: network first so updates land immediately, cache as fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (hit) return hit;
          // Offline and not cached: fall back to the start page for navigations
          if (req.mode === "navigate") {
            const shell = await caches.match("./index.html");
            if (shell) return shell;
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        })
    );
  }
});
