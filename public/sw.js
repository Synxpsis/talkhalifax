// TalkHalifax service worker: the app shell always opens, stories you've read stay readable offline, and push alerts
// for urgent notices arrive here. Everything is network-first, so a deploy shows up on the next load; the caches are
// only a fallback for when there's no connection.
const VERSION = "th-v6";
const SHELL = `${VERSION}-shell`, DATA = `${VERSION}-data`, FONTS = "th-fonts";
const SHELL_FILES = ["/", "/app.js", "/events.js", "/alerts.js", "/transit.js", "/stats.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/favicon-32.png"];
// Data worth keeping for offline reading; everything else under /api, /auth, /rooms and /mcp always goes to the network
const KEEP = /^\/api\/(stories(\/[^/]+)?|weather|alerts|events|transit\/alerts)$/;
const MAX_STORIES = 60;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Try the network; keep a copy of what worked; fall back to the copy when offline. */
async function networkFirst(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

/** Keep the most recently read stories; drop the oldest beyond MAX_STORIES. */
async function trimStories() {
  const cache = await caches.open(DATA);
  const stories = (await cache.keys()).filter(r => /\/api\/stories\/[^/]+$/.test(new URL(r.url).pathname));
  for (const r of stories.slice(0, Math.max(0, stories.length - MAX_STORIES))) await cache.delete(r);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache first, they never change at a given URL
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => (await c.match(req)) || fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;

  // Pages: the one page, with the hash doing the routing, so any navigation falls back to the cached shell
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "/"));
    return;
  }
  if (KEEP.test(url.pathname)) {
    e.respondWith(networkFirst(req, DATA, url.pathname).then(res => { e.waitUntil(trimStories()); return res; }));
    return;
  }
  if (/^\/(api|auth|rooms|mcp|telegram)\//.test(url.pathname) || url.pathname === "/mcp") return;
  // Static files (scripts, icons, route lines)
  e.respondWith(networkFirst(req, SHELL));
});

// ---------- push alerts (urgent notices the editor chose to send) ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "TalkHalifax", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "TalkHalifax", {
    body: d.body || "",
    tag: d.tag || "talkhalifax",
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    data: { url: d.url || "/#notices" },
    timestamp: d.at || Date.now(),
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) { await win.focus(); return win.navigate(target).catch(() => win.postMessage({ t: "go", url: target })); }
    return self.clients.openWindow(target);
  })());
});
