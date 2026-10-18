// Service worker : l'appli fonctionne hors ligne. Les fichiers sont mis en cache par version :
// à chaque modification de l'appli, augmenter VERSION (et APP_VERSION dans app.js).
const VERSION = "1.1.0";
const CACHE = `pypriority-${VERSION}`;
const SHELL = [
  "./", "index.html", "style.css", "app.js", "store.js", "sync.js", "google.js", "calendar.js", "config.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
];
// En local (développement), on privilégie le réseau pour voir les modifications tout de suite.
const DEV = ["localhost", "127.0.0.1"].includes(self.location.hostname);
const INDEX = new URL("./", self.location).href;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("pypriority-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => { if (event.data === "skipWaiting") self.skipWaiting(); });

self.addEventListener("fetch", event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // Google : toujours le réseau
  if (/\/tests\.(html|js)$/.test(url.pathname)) return;
  const key = req.mode === "navigate" ? INDEX : req;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (DEV) {
      try {
        const r = await fetch(req, { cache: "no-cache" });
        if (r.ok) cache.put(key, r.clone());
        return r;
      } catch {
        return (await cache.match(key, { ignoreSearch: true })) || Response.error();
      }
    }
    return (await cache.match(key, { ignoreSearch: true })) || fetch(req);
  })());
});
