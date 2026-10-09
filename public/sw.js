/* DropRevive app shell. Network-first so a fresh deploy wins; cache is only the offline fallback. */
const CACHE = "droprevive-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname === "/share" && request.method === "POST") {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        // Only the app itself falls back to the cached shell. /privacy must not turn into the app while offline.
        if (request.mode === "navigate" && url.pathname === "/") {
          const home = await cache.match("/");
          if (home) return home;
        }
        return new Response(offlineText(request), {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })(),
  );
});

/** Same strings as sw.offline. This file cannot import the language packs. */
function offlineText(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = /(?:^|;\s*)droprevive\.locale=([^;]+)/.exec(cookie);
  let id = match ? decodeURIComponent(match[1]) : "";
  if (id !== "en" && id !== "zh") {
    const first = ((request.headers.get("accept-language") || "").split(",")[0] || "").toLowerCase();
    id = first.startsWith("en") ? "en" : "zh";
  }
  return id === "en"
    ? "Offline, and this page is not cached on this device yet."
    : "离线，且这台设备还没有缓存这个页面。";
}

async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open("droprevive-share");
  const stale = await cache.keys();
  await Promise.all(stale.map((key) => cache.delete(key)));
  const text = [form.get("title"), form.get("text"), form.get("url")].filter(Boolean).join("\n");
  await cache.put("/share-text", new Response(text));
  let index = 0;
  for (const value of form.getAll("media")) {
    if (typeof value === "string") continue;
    await cache.put(
      `/share-file/${index}`,
      new Response(value, {
        headers: {
          "content-type": value.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(value.name || `file-${index}`),
        },
      }),
    );
    index += 1;
  }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "droprevive-share", text });
  return Response.redirect("/?shared=1", 303);
}
