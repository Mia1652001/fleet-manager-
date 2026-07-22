// Fleet Manager service worker.
//
// Caching strategy:
//   * Our own files  -> network first, cache as fallback, so a new upload is
//     picked up straight away and the app still opens when offline.
//   * Libraries and fonts (gstatic / Google Fonts) -> cache first. These are
//     the big, slow downloads and rarely change; this is the real speed gain.
//   * Firebase data and auth traffic -> never cached.
//
// Bump CACHE_VERSION to force every device to discard its cache.

const CACHE_VERSION = "fleet-v2";
const APP_CACHE = `${CACHE_VERSION}-app`;
const LIB_CACHE = `${CACHE_VERSION}-lib`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./store.js",
  "./firebase-init.js",
  "./view-fleet.js",
  "./view-bookings.js",
  "./view-customers.js",
  "./view-billing.js",
  "./view-maintenance.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const LIB_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];
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
      .catch(() => self.skipWaiting())
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

  if (NEVER_CACHE.some(h => url.hostname.includes(h))) return;

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
          if (req.mode === "navigate") {
            const shell = await caches.match("./index.html");
            if (shell) return shell;
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        })
    );
  }
});
