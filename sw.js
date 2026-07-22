// Self-removing service worker.
//
// The caching layer was making development confusing: uploads were not always
// visible because an older copy was being served. This worker deletes every
// cache it finds and unregisters itself. Once every device has loaded this
// version, caching is gone and the app always loads fresh files.
//
// A proper caching worker can be reintroduced later, when the app is stable.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach(c => c.navigate(c.url));
  })());
});

// Never serve from cache — always go to the network.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
