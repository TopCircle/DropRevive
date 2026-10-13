import assert from "node:assert/strict";
import test from "node:test";
import { BYE, createLanSession, type LanDeps } from "./lan-session.ts";
import type { LanHooks, LanLink, TransferLink } from "./link.ts";
import { encodeChunk } from "./protocol.ts";

const PEER_BATCH = "ABCDEFGH";
const PEER_FILE = "HGFEDCBA";

function harness(overrides: Partial<LanDeps> = {}) {
  const calls: string[] = [];
  const toasts: string[] = [];
  const warnings: string[] = [];
  const revoked: string[] = [];
  const sent: unknown[] = [];
  let urls = 0;
  let hooks: { current: LanHooks } | null = null;
  let linkRef: { current: TransferLink } | null = null;
  const fakeLink: LanLink = {
    fail(message) {
      calls.push(`fail:${message}`);
      if (!linkRef) return;
      linkRef.current.finished = true;
      hooks?.current.say("failed", message);
    },
    dispose() {
      calls.push("dispose");
      if (linkRef) linkRef.current.alive = false;
    },
    openSocket(role) {
      calls.push(`open:${role}`);
    },
    ensureSession() {},
    takeSignal() {},
    clearRecovery() {},
    sendLease() {},
    syncLease() {},
    applyFault(fault) {
      calls.push(`fault:${fault}`);
    },
    nudge() {
      calls.push("nudge");
    },
  };
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  const deps: LanDeps = {
    t: t as LanDeps["t"],
    deviceName: () => "me",
    notify: {
      message: (text) => void toasts.push(text),
      warning: (text) => void warnings.push(text),
    },
    fetch: async () => new Response(JSON.stringify({ code: "QWERTYUP", hostToken: "tok" }), { status: 200 }),
    createLink(ref, hooksRef) {
      linkRef = ref;
      hooks = hooksRef;
      return fakeLink;
    },
    formatBytes: (n) => `${n}B`,
    createObjectURL: () => `blob:${(urls += 1)}`,
    revokeObjectURL: (url) => void revoked.push(url),
    random: (n) => new Uint8Array(n).map((_, i) => i * 7 + 3),
    now: () => 1,
    ...overrides,
  };
  const session = createLanSession(deps);
  const channel = {
    readyState: "open",
    send: (data: unknown) => void sent.push(data),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  function connect() {
    session.link().channel = channel as unknown as TransferLink["channel"];
    session.link().opened = true;
    hooks!.current.say("connected", "transfer.connected");
  }
  function peerOffers(files: { id: string; name: string; size: number; mime: string }[]) {
    hooks!.current.onData(JSON.stringify({ t: "manifest", id: PEER_BATCH, textBytes: 0, files }));
  }
  function chunk(id: string, bytes: Uint8Array) {
    const frame = encodeChunk({ id, offset: 0, bytes });
    hooks!.current.onData(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
  }
  return { session, calls, toasts, warnings, revoked, sent, hooks: () => hooks!.current, connect, peerOffers, chunk };
}

test("closing the panel keeps the session; only 断开 and pagehide end it", () => {
  const h = harness();
  h.session.setPanelOpen(true);
  h.connect();
  h.session.setPanelOpen(false);
  h.session.setPanelOpen(true);
  assert.equal(h.session.store.getState().phase, "connected");
  assert.deepEqual(h.calls, []);
  h.session.disconnect();
  assert.deepEqual(h.calls, ["fail:transfer.youLeft"]);
  assert.equal(h.session.store.getState().phase, "idle");
  h.session.pageHide();
  assert.deepEqual(h.calls.slice(-2), ["fail:transfer.youLeft", "dispose"]);
});

test("a failure notice is cleared by 重试, a new room and a later connection", async () => {
  const h = harness();
  h.connect();
  h.hooks().say("failed", "transfer.failed");
  const tones = () => h.session.store.getState().entries.filter((e) => e.kind === "notice").map((e) => (e.kind === "notice" ? e.tone : ""));
  assert.ok(tones().includes("fail"));
  h.session.retry();
  assert.ok(!tones().includes("fail"));
  assert.equal(h.session.store.getState().phase, "idle");
  await h.session.createRoom();
  assert.equal(h.session.store.getState().phase, "hosting");
  assert.ok(h.calls.includes("open:host"));
});

test("a room reply that arrives after 断开 is ignored", async () => {
  let release: (r: Response) => void = () => {};
  const h = harness({ fetch: () => new Promise<Response>((resolve) => (release = resolve)) });
  const pending = h.session.createRoom();
  h.session.disconnect();
  release(new Response(JSON.stringify({ code: "QWERTYUP", hostToken: "tok" }), { status: 200 }));
  await pending;
  assert.ok(!h.calls.includes("open:host"));
});

test("an offer while the panel is closed waits for the user and raises a toast", () => {
  const h = harness();
  h.connect();
  h.peerOffers([{ id: PEER_FILE, name: "a.txt", size: 3, mime: "text/plain" }]);
  const state = h.session.store.getState();
  assert.equal(state.phase, "confirm");
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0]!, /transfer\.toastOffer/);
  // No auto-accept: nothing went back to the peer.
  assert.equal(h.sent.length, 0);
});

test("received files: toast while closed, saved revokes the thumbnail, dismiss releases the bytes", () => {
  const h = harness();
  h.connect();
  h.peerOffers([{ id: PEER_FILE, name: "p.png", size: 3, mime: "image/png" }]);
  h.session.accept();
  h.chunk(PEER_FILE, new Uint8Array([1, 2, 3]));
  let state = h.session.store.getState();
  assert.equal(state.saves.length, 1);
  assert.equal(state.previews[PEER_FILE], "blob:1");
  assert.ok(h.toasts.some((text) => text.startsWith("transfer.toastReceived")));
  h.session.markSaved(PEER_FILE);
  state = h.session.store.getState();
  assert.ok(state.savedIds.has(PEER_FILE));
  assert.equal(state.previews[PEER_FILE], undefined);
  assert.deepEqual(h.revoked, ["blob:1"]);
  h.session.dismiss(PEER_FILE);
  assert.equal(h.session.store.getState().saves.length, 0);
});

test("no toasts while the panel is open", () => {
  const h = harness();
  h.session.setPanelOpen(true);
  h.connect();
  h.peerOffers([{ id: PEER_FILE, name: "a.txt", size: 1, mime: "text/plain" }]);
  assert.equal(h.toasts.length, 0);
});

test("thumbnails are revoked when the session ends; unsaved files stay saveable", () => {
  const h = harness();
  h.connect();
  h.peerOffers([{ id: PEER_FILE, name: "p.png", size: 2, mime: "image/png" }]);
  h.session.accept();
  h.chunk(PEER_FILE, new Uint8Array([9, 9]));
  h.hooks().onServer({ type: "peer-left", reason: "bye" });
  const state = h.session.store.getState();
  assert.equal(state.phase, "idle");
  assert.deepEqual(state.previews, {});
  assert.deepEqual(h.revoked, ["blob:1"]);
  assert.equal(state.saves.length, 1);
});

test("visibility back to visible nudges the link", () => {
  const h = harness();
  h.session.visible();
  assert.deepEqual(h.calls, ["nudge"]);
});

function receiveUnsaved(h: ReturnType<typeof harness>) {
  h.connect();
  h.peerOffers([{ id: PEER_FILE, name: "a.bin", size: 2, mime: "application/octet-stream" }]);
  h.session.accept();
  h.chunk(PEER_FILE, new Uint8Array([4, 5]));
}

test("local 断开 says bye and clears the session back to the start", async () => {
  const h = harness();
  await h.session.createRoom();
  receiveUnsaved(h);
  assert.equal(h.session.unsavedCount(), 1);
  h.session.disconnect();
  const state = h.session.store.getState();
  assert.ok(h.sent.includes(BYE));
  assert.equal(state.phase, "idle");
  assert.deepEqual(state.entries, []);
  assert.equal(state.code, "");
  assert.equal(state.peerName, "");
  assert.equal(state.saves.length, 0);
  assert.equal(state.note, "");
});

test("a peer's bye clears the session but keeps unsaved files with a notice", () => {
  const h = harness();
  receiveUnsaved(h);
  h.hooks().onData(BYE);
  const state = h.session.store.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.saves.length, 1);
  assert.equal(state.entries.length, 1, "only the batch holding the unsaved file stays");
  assert.match(state.note, /transfer\.peerLeft/);
  assert.match(state.note, /transfer\.keptUnsaved/);
});

test("a blip (no bye) shows reconnecting and keeps the session on recovery", async () => {
  const h = harness();
  await h.session.createRoom();
  receiveUnsaved(h);
  const before = h.session.store.getState().entries.length;
  h.hooks().note("transfer.reconnecting");
  assert.equal(h.session.store.getState().note, "transfer.reconnecting");
  h.hooks().say("connected", "transfer.connected");
  const state = h.session.store.getState();
  assert.equal(state.phase, "connected");
  assert.equal(state.code, "QWERTYUP");
  assert.equal(state.saves.length, 1);
  assert.ok(state.entries.length >= before);
  assert.ok(!state.entries.some((entry) => entry.kind === "notice" && entry.tone === "reconnect"));
});

test("giving up after the reconnect window clears the session, keeps unsaved files", () => {
  const h = harness();
  receiveUnsaved(h);
  h.hooks().say("failed", "transfer.linkLost");
  const state = h.session.store.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.saves.length, 1);
  assert.match(state.note, /transfer\.peerGone/);
});

test("the server's gone notice (peer never came back) also clears", () => {
  const h = harness();
  h.connect();
  h.hooks().onServer({ type: "peer-left", reason: "gone" });
  const state = h.session.store.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.note, "transfer.peerGone");
});

test("a direct-failed notice from the other side shows the failure message, not 'peer left'", () => {
  const h = harness();
  h.hooks().onServer({ type: "peer-left", reason: "direct-failed" });
  const state = h.session.store.getState();
  assert.equal(state.phase, "failed");
  assert.equal(state.note, "transfer.failed");
});
