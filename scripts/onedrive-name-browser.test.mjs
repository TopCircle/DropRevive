/**
 * Synthetic Chrome check for an OneDrive-shaped download.
 * The file host is another origin and names the body with a storage id.
 * A direct click keeps that id. Fetching it and saving a Blob keeps the original name.
 * No live OneDrive account or credential.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const STORAGE = "b_b033f1af-78ac-4936-a732-4be056c20b0f";
const PDF = "会议 记录.v1.2.final.pdf";
const OTHER_PDF = "附件 说明.v1.2.final.pdf";
const TAR = "报告 终稿.tar.gz";
const CAP = 32 * 1024 * 1024;
const chromeBin = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(
  (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0,
);

function stopChrome(chrome) {
  if (!chrome?.pid || chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => {
    chrome.once("exit", resolve);
    if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
  });
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
  }
  return Promise.race([exited, delay(1000)]);
}

function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

test(
  "OneDrive-shaped cross-origin download keeps the original name only through a Blob",
  { skip: chromeBin ? false : "Chrome is not installed; Firefox, Safari, and installed PWA were not run" },
  async (t) => {
    const smallPdf = Buffer.from("pdf-bytes-v1");
    const smallTar = Buffer.from("tar-bytes-v2");
    const capBody = Buffer.alloc(CAP, 0x61);
    capBody[0] = 0x25;
    capBody[CAP - 1] = 0x0a;
    const bodies = new Map([
      ["/pdf", smallPdf],
      ["/tar", smallTar],
      ["/cap", capBody],
    ]);
    const hits = [];
    const auths = [];
    const files = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      hits.push(url.pathname);
      auths.push(req.headers.authorization ?? "");
      const body = bodies.get(url.pathname);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
        "content-disposition": `attachment; filename="${STORAGE}"`,
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(body);
    });
    await new Promise((resolve) => files.listen(0, "127.0.0.1", resolve));
    const filePort = files.address().port;
    const html = `<!doctype html><meta charset="utf-8"><title>onedrive-name</title><script>
window.clickDirect = (url, name) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
};
window.saveBlob = async (url, name) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("fetch failed");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  return blob.size;
};
window.refuseLarge = (size) => size > ${CAP} ? "refused" : "would-fetch";
</script>`;
    const page = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    const pagePort = page.address().port;
    const downloads = mkdtempSync(join(tmpdir(), "od-name-"));
    const profile = mkdtempSync(join(tmpdir(), "od-name-profile-"));
    const debug = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
      probe.on("error", reject);
    });
    const chrome = spawn(chromeBin, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-extensions",
      "--disable-popup-blocking",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debug}`,
      "about:blank",
    ], { stdio: "ignore", detached: true });
    let version;
    try {
      for (let i = 0; i < 50 && !version; i++) {
        try {
          version = await fetch(`http://127.0.0.1:${debug}/json/version`).then((res) => res.json());
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
      const target = await send("Target.createTarget", { url: `http://127.0.0.1:${pagePort}/` });
      const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
      const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", {
          expression, awaitPromise: true, returnByValue: true, userGesture: true,
        }, sessionId);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      for (let i = 0; i < 40; i++) {
        const state = await evaluate("document.readyState");
        if (state === "complete") break;
        await delay(50);
      }
      const clearDir = () => {
        for (const name of readdirSync(downloads)) rmSync(join(downloads, name), { force: true });
      };
      async function download(expression) {
        clearDir();
        const before = events.length;
        const value = await evaluate(expression);
        let began;
        let done;
        for (let i = 0; i < 200 && !done; i++) {
          began = events.slice(before).filter((event) => event.method === "Browser.downloadWillBegin").at(-1);
          const guid = began?.params?.guid;
          done = guid
            ? events.slice(before).find((event) => event.method === "Browser.downloadProgress" && event.params?.guid === guid && event.params.state === "completed")
            : undefined;
          if (!done) await delay(50);
        }
        if (!done) throw new Error(`download did not finish for ${expression}`);
        await delay(100);
        const names = readdirSync(downloads);
        assert.equal(names.length, 1);
        const filePath = join(downloads, names[0]);
        return {
          value,
          suggestedFilename: began.params.suggestedFilename,
          diskName: names[0],
          bytes: statSync(filePath).size,
          sha256: await hashFile(filePath),
        };
      }
      const origin = `http://127.0.0.1:${filePort}`;
      const direct = await download(`window.clickDirect(${JSON.stringify(origin + "/pdf")}, ${JSON.stringify(PDF)})`);
      assert.equal(direct.suggestedFilename, STORAGE);
      assert.equal(direct.diskName, STORAGE);
      assert.equal(direct.bytes, smallPdf.length);
      assert.equal(direct.sha256, sha256(smallPdf));

      const pdf = await download(`window.saveBlob(${JSON.stringify(origin + "/pdf")}, ${JSON.stringify(OTHER_PDF)})`);
      assert.equal(pdf.suggestedFilename, OTHER_PDF);
      assert.equal(pdf.diskName, OTHER_PDF);
      assert.equal(pdf.bytes, smallPdf.length);
      assert.equal(pdf.sha256, sha256(smallPdf));

      const tar = await download(`window.saveBlob(${JSON.stringify(origin + "/tar")}, ${JSON.stringify(TAR)})`);
      assert.equal(tar.suggestedFilename, TAR);
      assert.equal(tar.diskName, TAR);
      assert.equal(tar.bytes, smallTar.length);
      assert.equal(tar.sha256, sha256(smallTar));

      const cap = await download(`window.saveBlob(${JSON.stringify(origin + "/cap")}, ${JSON.stringify(PDF)})`);
      assert.equal(cap.suggestedFilename, PDF);
      assert.equal(cap.diskName, PDF);
      assert.equal(cap.bytes, CAP);
      assert.equal(cap.sha256, sha256(capBody));

      const hitsBefore = hits.length;
      const eventsBefore = events.length;
      const refused = await evaluate(`window.refuseLarge(${CAP + 1})`);
      await delay(300);
      assert.equal(refused, "refused");
      assert.equal(hits.slice(hitsBefore).includes("/over"), false);
      assert.equal(events.slice(eventsBefore).some((event) => event.method === "Browser.downloadWillBegin"), false);
      assert.equal(auths.every((value) => value === ""), true);
      console.log(
        `onedrive-name-browser ${version.Browser} direct=${direct.suggestedFilename}/${direct.bytes} pdf=${pdf.diskName}/${pdf.bytes} tar=${tar.diskName}/${tar.bytes} cap=${cap.diskName}/${cap.bytes} over=refused`,
      );
      ws.close();
    } finally {
      await stopChrome(chrome);
      files.close();
      page.close();
      removeTree(profile);
      removeTree(downloads);
    }
  },
);
