/* Rappels — service worker.
   Bumper VERSION à CHAQUE déploiement, sinon le téléphone garde
   l'ancienne version en cache. */
const VERSION = "v4";
const CACHE_NAME = `rappels-${VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=4",
  "./js/app.js?v=4",
  "./js/store.js",
  "./js/parse.js",
  "./js/suggest.js",
  "./js/voice.js",
  "./js/dates.js",
  "./js/ui.js",
  "./js/motion.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Coquille : réseau d'abord, cache en secours hors ligne. L'API
   (autre origine) ne passe jamais par ici. */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});

/* ── Notifications ── */

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Rappel", body: e.data?.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Rappel", {
      body: d.body || "",
      tag: d.tag || d.id || "rappel",
      data: { id: d.id || null },
      icon: "icons/icon-192.png",
      renotify: true,
    });
    if (typeof d.badge === "number" && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(d.badge); } catch (_) {}
    }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: "push", id: d.id }));
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.id;
  const url = new URL(id ? `./?r=${encodeURIComponent(id)}` : "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) {
        if (id) w.postMessage({ type: "open", id });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
