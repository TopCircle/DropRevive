/**
 * Chrome's SDP parser rejects a session attribute placed between v= and o=
 * (OperationError: Expect line: o=). The signaled text is attachStreamCap's
 * return value: Chrome may strip the unknown attribute from localDescription,
 * and the peer's cap is read from the text we send.
 *
 * This checks setLocalDescription and setRemoteDescription only. iceServers
 * is empty. A data channel is not required to open. UDP here may be blocked,
 * so a parsed description is not a same-Wi-Fi connection.
 * Skips only when no Chrome binary exists. A binary that never opens a
 * debugging port fails the test; that skip would not be a pass.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { attachStreamCap, negotiatedLimits, parseStreamCap } from "../src/lib/transfer/stream-cap.ts";
import { V2_MAX_FILE_IOS_BYTES } from "../src/lib/transfer/limits.ts";

const chromeBin = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(
  (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0,
);

const PAGE = `(() => {
  const fail = (error) => ({ ok: false, name: error && error.name, message: error && error.message ? error.message : String(error) });
  const close = () => { window.a?.close(); window.b?.close(); };
  window.make = async () => {
    close();
    window.a = new RTCPeerConnection({ iceServers: [] });
    window.a.createDataChannel("drop");
    const offer = await window.a.createOffer();
    return offer.sdp || "";
  };
  window.putOffer = async (offerSdp) => {
    window.b?.close();
    window.b = new RTCPeerConnection({ iceServers: [] });
    try {
      await window.a.setLocalDescription({ type: "offer", sdp: offerSdp });
      await window.b.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await window.b.createAnswer();
      const local = window.a.localDescription && window.a.localDescription.sdp || "";
      return { ok: true, rawAnswer: answer.sdp || "", localHasCap: local.includes("a=x-droprevive:stream-v2"), aState: window.a.connectionState };
    } catch (error) {
      close();
      return fail(error);
    }
  };
  window.putAnswer = async (answerSdp) => {
    try {
      await window.b.setLocalDescription({ type: "answer", sdp: answerSdp });
      await window.a.setRemoteDescription({ type: "answer", sdp: answerSdp });
      const local = window.b.localDescription && window.b.localDescription.sdp || "";
      return { ok: true, answerLocalHasCap: local.includes("a=x-droprevive:stream-v2"), aState: window.a.connectionState, bState: window.b.connectionState };
    } catch (error) {
      return fail(error);
    } finally {
      close();
    }
  };
  return "ready";
})()`;

test(
  "Chrome accepts a stream-v2 attribute before the first m= line on a generated offer and answer",
  { skip: chromeBin ? false : "Chrome is not installed; Firefox, Safari, and installed PWA were not run" },
  async () => {
    const debugPort = await freePort();
    const profile = mkdtempSync(join(tmpdir(), "sdp-cap-profile-"));
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
    try {
      let version;
      for (let i = 0; i < 50 && !version; i++) {
        try {
          version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((res) => res.json());
        } catch {
          await delay(100);
        }
      }
      assert.ok(version?.webSocketDebuggerUrl, "Chrome did not open a debugging port; this is a failure, not a skip");
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((res) => res.json());
      const page = list.find((target) => target.type === "page");
      assert.ok(page?.webSocketDebuggerUrl);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("chrome websocket failed")), { once: true });
      });
      const pending = new Map();
      let seq = 0;
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      });
      const send = (method, params) => {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      };
      const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails));
        return result.result?.value;
      };
      assert.equal(await evaluate(PAGE), "ready");

      const raw = await evaluate("window.make()");
      assert.equal(typeof raw, "string");
      assert.ok(raw.startsWith("v=0"));
      assert.match(raw, /(?:\r\n|\n)m=/);
      const oldPeer = await evaluate(`window.putOffer(${JSON.stringify(raw)})`);
      assert.equal(oldPeer.ok, true, `${oldPeer.name || ""} ${oldPeer.message || ""}`);
      const oldAnswer = await evaluate(`window.putAnswer(${JSON.stringify(oldPeer.rawAnswer)})`);
      assert.equal(oldAnswer.ok, true, `${oldAnswer.name || ""} ${oldAnswer.message || ""}`);
      assert.equal(parseStreamCap(raw), null);
      assert.equal(negotiatedLimits("other", null).v2, false);

      const crlf = await roundTrip(evaluate, (sdp) => sdp, "other", "ios");
      const lf = await roundTrip(evaluate, (sdp) => sdp.replace(/\r\n/g, "\n"), "safari", "other");

      const again = await evaluate("window.make()");
      const mediaAt = again.search(/(?:\r\n|\n)m=/);
      const sessionOnly = again.slice(0, mediaAt + (again[mediaAt] === "\r" ? 2 : 1));
      assert.equal(sessionOnly.includes("m="), false);
      assert.equal(attachStreamCap(sessionOnly, "other"), sessionOnly);
      await evaluate("window.a && window.a.close()");

      console.log(
        `sdp-cap-browser ${version.Browser} parse-only; datachannel was not required; localDescription kept cap crlf=${crlf.offerLocalHasCap}/${crlf.answerLocalHasCap} lf=${lf.offerLocalHasCap}/${lf.answerLocalHasCap}`,
      );
      ws.close();
    } finally {
      chrome.kill("SIGKILL");
      await delay(200);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

async function roundTrip(evaluate, endings, offerPlat, answerPlat) {
  const generated = await evaluate("window.make()");
  const rawOffer = endings(generated);
  const offer = attachStreamCap(rawOffer, offerPlat);
  const begun = await evaluate(`window.putOffer(${JSON.stringify(offer)})`);
  assert.equal(begun.ok, true, `${begun.name || ""} ${begun.message || ""}`);
  assert.equal(attachStreamCap(offer, offerPlat === "ios" ? "other" : "ios"), offer);
  const offerLines = offer.split(/\r\n|\n/);
  const capAt = offerLines.indexOf(`a=x-droprevive:stream-v2 ${offerPlat}`);
  const originAt = offerLines.findIndex((line) => line.startsWith("o="));
  const mediaAt = offerLines.findIndex((line) => line.startsWith("m="));
  assert.ok(capAt > originAt);
  assert.equal(capAt, mediaAt - 1);
  assert.deepEqual(parseStreamCap(offer), { v2: true, plat: offerPlat });
  if (!begun.localHasCap) assert.deepEqual(parseStreamCap(offer), { v2: true, plat: offerPlat });
  const answer = attachStreamCap(endings(begun.rawAnswer), answerPlat);
  assert.equal(attachStreamCap(answer, "ios"), answer);
  assert.deepEqual(parseStreamCap(answer), { v2: true, plat: answerPlat });
  const finished = await evaluate(`window.putAnswer(${JSON.stringify(answer)})`);
  assert.equal(finished.ok, true, `${finished.name || ""} ${finished.message || ""}`);
  if (!finished.answerLocalHasCap) assert.deepEqual(parseStreamCap(answer), { v2: true, plat: answerPlat });
  const tighter = negotiatedLimits(offerPlat, parseStreamCap(answer));
  assert.equal(tighter.v2, true);
  if (offerPlat === "ios" || answerPlat === "ios") assert.equal(tighter.maxFileBytes, V2_MAX_FILE_IOS_BYTES);
  return { offerLocalHasCap: begun.localHasCap, answerLocalHasCap: finished.answerLocalHasCap };
}

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
