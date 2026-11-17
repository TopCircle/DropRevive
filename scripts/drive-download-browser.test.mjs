/**
 * Synthetic Chrome check for the real service worker.
 * A same-origin stream URL with <a download> bypasses the worker and the browser cancels it.
 * The same URL without that attribute is intercepted and the transferred bytes complete.
 * Skips when Chrome is missing or cannot open a debugging port. GitHub-hosted
 * runners may have a Chrome binary that never binds that port; that is a skip,
 * not a failure. No Google account or credentials.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const chromeBin = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(
  (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0,
);

const BYTES = 4096;

test(
  "service worker stream: download attribute cancels, a plain click completes",
  { skip: chromeBin ? false : "Chrome is not installed; Firefox, Safari, and installed PWA were not run" },
  async (t) => {
    const swPath = process.env.DRIVE_SW_PATH || new URL("../public/sw.js", import.meta.url);
    const swSource = readFileSync(swPath);
    const html = `<!doctype html><meta charset="utf-8"><title>drive-download</title><script>
function post(data, transfer) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 8000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
    try { navigator.serviceWorker.controller.postMessage(data, [channel.port2, ...transfer]); }
    catch (error) { clearTimeout(timer); resolve({ ok: false, error: String(error) }); }
  });
}
window.boot = async () => {
  await navigator.serviceWorker.register("/sw.js");
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return { controlled: Boolean(navigator.serviceWorker.controller) };
};
window.arm = async (name) => {
  const id = crypto.randomUUID();
  const bytes = new Uint8Array(${BYTES}).fill(7);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const ack = await post({
    type: "droprevive-drive-download", id, fileName: name, mime: "application/octet-stream", size: bytes.byteLength, stream,
  }, [stream]);
  return { ack, url: location.origin + "/__drive-download/" + id, id };
};
window.clickDownload = (url, name, withDownloadAttr) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  if (withDownloadAttr) anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
};
</script>`;

    const hits = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      hits.push(req.method + " " + url.pathname);
      if (url.pathname === "/sw.js") {
        res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
        res.end(swSource);
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("missing");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const debugPort = await freePort();
    const profile = mkdtempSync(join(tmpdir(), "drive-dl-profile-"));
    const downloads = mkdtempSync(join(tmpdir(), "drive-dl-files-"));
    const chrome = spawn(
      chromeBin,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-extensions",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debugPort}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let version;
    try {
      for (let i = 0; i < 50 && !version; i++) {
        try {
          version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((res) => res.json());
        } catch {
          await delay(100);
        }
      }
      if (!version?.webSocketDebuggerUrl) {
        t.skip("Chrome did not open a debugging port; Firefox, Safari, and installed PWA were not run");
        return;
      }

      const ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      const pending = new Map();
      const events = [];
      let seq = 0;
      const send = (method, params = {}, sessionId) => {
        const id = ++seq;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      };
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
          return;
        }
        if (message.method) events.push(message);
      });

      const target = await send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
      const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      await send("Network.enable", {}, sessionId);
      await send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloads,
        eventsEnabled: true,
      });

      const evaluate = async (expression) => {
        const result = await send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          sessionId,
        );
        if (result.exceptionDetails) {
          throw new Error(JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails));
        }
        return result.result?.value;
      };
      for (let i = 0; i < 50; i++) {
        const state = await evaluate("document.readyState + ':' + typeof window.boot");
        if (state === "complete:function") break;
        await delay(100);
      }
      const boot = await evaluate("window.boot()");
      assert.equal(boot.controlled, true, "the page must be controlled before the download");

      const waitFor = (url) =>
        new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            const began = events.filter(
              (event) => event.method === "Browser.downloadWillBegin" && event.params?.url === url,
            );
            const guid = began.at(-1)?.params?.guid;
            const progress = guid
              ? events.filter((event) => event.method === "Browser.downloadProgress" && event.params?.guid === guid)
              : [];
            const done = progress.find((event) => event.params.state === "completed" || event.params.state === "canceled");
            if (done) {
              clearInterval(timer);
              resolve({
                state: done.params.state,
                receivedBytes: done.params.receivedBytes,
                totalBytes: done.params.totalBytes,
              });
            }
          }, 40);
          setTimeout(() => {
            clearInterval(timer);
            reject(new Error(`no finished download for ${url}`));
          }, 5000);
        });

      const bypass = await evaluate('window.arm("bypass.bin")');
      assert.equal(bypass.ack?.ok, true);
      const bypassDone = waitFor(bypass.url);
      await evaluate(`window.clickDownload(${JSON.stringify(bypass.url)}, "bypass.bin", true)`);
      const bypassResult = await bypassDone;
      assert.equal(bypassResult.state, "canceled");
      assert.equal(bypassResult.receivedBytes, 0);
      assert.ok(hits.includes("GET /__drive-download/" + bypass.id), "a.download must hit the origin");

      const fixed = await evaluate('window.arm("fixed.bin")');
      assert.equal(fixed.ack?.ok, true);
      const fixedDone = waitFor(fixed.url);
      const hitsBefore = hits.length;
      await evaluate(`window.clickDownload(${JSON.stringify(fixed.url)}, "fixed.bin", false)`);
      const fixedResult = await fixedDone;
      const alive = await evaluate("document.title");
      assert.equal(fixedResult.state, "completed");
      assert.equal(fixedResult.receivedBytes, BYTES);
      assert.equal(alive, "drive-download");
      assert.equal(
        hits.slice(hitsBefore).includes("GET /__drive-download/" + fixed.id),
        false,
        "the fixed click must be served by the service worker",
      );
      console.log(
        `drive-download-browser ${version.Browser} sw=${swPath} bytes=${BYTES} bypass=${bypassResult.state}/${bypassResult.receivedBytes} fixed=${fixedResult.state}/${fixedResult.receivedBytes}`,
      );
      ws.close();
    } finally {
      chrome.kill("SIGKILL");
      server.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(downloads, { recursive: true, force: true });
    }
  },
);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}
