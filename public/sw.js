/* DropRevive app shell. Network-first so a fresh deploy wins; cache is only the offline fallback. */
const CACHE = "droprevive-shell-v1";

/* Same-origin streaming download for Google Drive (see src/lib/drop/download.ts).
   The access token, when used, arrives via postMessage and is never placed in a URL. */
const DRIVE_DOWNLOAD_TYPE = "droprevive-drive-download";
const DRIVE_DOWNLOAD_PATH = "/__drive-download/";
/** @type {Map<string, { stream?: ReadableStream, fileUrl?: string, accessToken?: string, fileName: string, mime: string, size?: number, expires: number }>} */
const pendingDriveDownloads = new Map();

function isDriveDownloadId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function contentDisposition(fileName) {
  const raw = String(fileName || "download").replace(/[\r\n"]/g, "_");
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function isAllowedGoogleMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.googleapis.com" &&
      parsed.pathname.startsWith("/drive/v3/files/") &&
      parsed.searchParams.get("alt") === "media"
    );
  } catch {
    return false;
  }
}

function sweepDriveDownloads() {
  const now = Date.now();
  for (const [id, job] of pendingDriveDownloads) {
    if (job.expires < now) pendingDriveDownloads.delete(id);
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== DRIVE_DOWNLOAD_TYPE) return;
  const reply = event.ports && event.ports[0];
  const say = (ok, error) => {
    try {
      reply?.postMessage(error ? { ok, error } : { ok });
    } catch {
      /* the page may have gone away */
    }
  };
  sweepDriveDownloads();
  const id = data.id;
  if (!isDriveDownloadId(id)) {
    say(false, "bad-id");
    return;
  }
  const fileName = typeof data.fileName === "string" && data.fileName ? data.fileName : "download";
  const mime = typeof data.mime === "string" && data.mime ? data.mime : "application/octet-stream";
  const size = typeof data.size === "number" && Number.isFinite(data.size) ? data.size : undefined;
  const expires = Date.now() + 60_000;
  if (data.stream && typeof data.stream.getReader === "function") {
    pendingDriveDownloads.set(id, { stream: data.stream, fileName, mime, size, expires });
    say(true);
    return;
  }
  const fileUrl = data.fileUrl;
  const accessToken = data.accessToken;
  if (
    typeof fileUrl === "string" &&
    typeof accessToken === "string" &&
    accessToken.length > 0 &&
    accessToken.length < 8192 &&
    isAllowedGoogleMediaUrl(fileUrl)
  ) {
    pendingDriveDownloads.set(id, { fileUrl, accessToken, fileName, mime, size, expires });
    say(true);
    return;
  }
  say(false, "bad-payload");
});

async function streamDriveDownload(request) {
  const url = new URL(request.url);
  const id = url.pathname.slice(DRIVE_DOWNLOAD_PATH.length);
  sweepDriveDownloads();
  const job = pendingDriveDownloads.get(id);
  pendingDriveDownloads.delete(id);
  if (!job || job.expires < Date.now()) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers({
    "Content-Type": job.mime || "application/octet-stream",
    "Content-Disposition": contentDisposition(job.fileName),
    "Cache-Control": "no-store",
  });
  if (job.size && Number.isFinite(job.size) && job.size > 0) {
    headers.set("Content-Length", String(job.size));
  }
  if (job.stream) {
    return new Response(job.stream, { status: 200, headers });
  }
  try {
    const upstream = await fetch(job.fileUrl, {
      headers: { Authorization: "Bearer " + job.accessToken },
    });
    if (!upstream.ok || !upstream.body) {
      const status = upstream.status === 404 ? 404 : 502;
      return new Response("Download failed", { status, headers: { "Cache-Control": "no-store" } });
    }
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    const type = upstream.headers.get("Content-Type");
    if (type) headers.set("Content-Type", type);
    headers.set("Content-Disposition", contentDisposition(job.fileName));
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return new Response("Download failed", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}


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
  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith(DRIVE_DOWNLOAD_PATH) &&
    request.method === "GET"
  ) {
    event.respondWith(streamDriveDownload(request));
    return;
  }
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
