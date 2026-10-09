import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { RECONNECT_GRACE_MS } from "../src/lib/transfer/limits.ts";

// Miniflare's own DurableObjectNamespace types collide with the worker shim in
// server/cloudflare-workers.d.ts, so describe only the surface these tests use.
/**
 * @typedef {object} TestSocket
 * @property {() => void} accept
 * @property {() => void} close
 * @property {(type: "message", listener: (event: { data: unknown }) => void) => void} addEventListener
 */
/**
 * @typedef {object} RoomStub
 * @property {(input: { code: string; hostToken: string; hostName: string }) => Promise<unknown>} create
 * @property {(input: { guestToken: string; guestName: string }) => Promise<unknown>} join
 * @property {(url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; webSocket: TestSocket | null }>} fetch
 */
/**
 * @typedef {object} RoomNamespace
 * @property {(name: string) => unknown} idFromName
 * @property {(id: unknown) => RoomStub} get
 */

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "transfer-room.integration-entry.ts");
const scriptName = "transfer-room-test";
const className = "TransferRoomTest";

/** @type {Miniflare} */
let mf;

before(async () => {
  const bundled = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    external: ["cloudflare:workers"],
  });
  mf = new Miniflare({
    name: scriptName,
    script: bundled.outputFiles[0].text,
    modules: true,
    // Hoisted miniflare 4 workerd rejects dates after 2026-08-06. SQLite and hibernation do not need the production date.
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    unsafeInspectDurableObjects: true,
    durableObjects: {
      TRANSFER_ROOM: { className, useSQLite: true },
    },
  });
  await mf.ready;
});

after(async () => {
  await mf?.dispose();
});

function pause(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} code */
async function room(code) {
  const ns = /** @type {RoomNamespace} */ (/** @type {unknown} */ (await mf.getDurableObjectNamespace("TRANSFER_ROOM")));
  const stub = ns.get(ns.idFromName(code));
  const hostToken = `host-${code}`;
  const guestToken = `guest-${code}`;
  await stub.create({ code, hostToken, hostName: "Host" });
  await stub.join({ guestToken, guestName: "Guest" });
  return {
    stub,
    hostToken,
    guestToken,
    storage() {
      return mf.unsafeGetDurableObjectStorage(scriptName, className, { name: code });
    },
  };
}

/**
 * @param {RoomStub} stub
 * @param {string} token
 */
async function connect(stub, token) {
  const response = await stub.fetch(`https://room.test/ws?token=${encodeURIComponent(token)}`, {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  assert.ok(socket);
  socket.accept();
  /** @type {Array<Record<string, unknown>>} */
  const messages = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  await pause();
  return { socket, messages };
}

/** @param {RoomStub} stub */
async function alarm(stub) {
  const response = await stub.fetch("https://room.test/alarm", { headers: { "x-test-alarm": "1" } });
  assert.equal(response.status, 204);
  await pause();
}

/** @param {Array<Record<string, unknown>>} messages */
function peerLeft(messages) {
  return messages.filter((message) => message.type === "peer-left");
}

test("replacing a host socket does not start an absence or tell the guest", async () => {
  const { stub, hostToken, guestToken, storage } = await room("REPLACE1");
  const first = await connect(stub, hostToken);
  const guest = await connect(stub, guestToken);
  await connect(stub, hostToken);
  first.socket.close();
  await pause();
  assert.deepEqual(peerLeft(guest.messages), []);
  const rows = await (await storage()).exec("SELECT absent_host FROM room");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].absent_host, null);
});

test("the last host close records absence and an immediate alarm keeps the room", async () => {
  const { stub, hostToken, guestToken, storage } = await room("ABSENT01");
  const host = await connect(stub, hostToken);
  const guest = await connect(stub, guestToken);
  host.socket.close();
  await pause();
  assert.deepEqual(peerLeft(guest.messages), []);
  const marked = await (await storage()).exec("SELECT absent_host FROM room");
  assert.equal(typeof marked[0].absent_host, "number");
  await alarm(stub);
  assert.deepEqual(peerLeft(guest.messages), []);
  const rows = await (await storage()).exec("SELECT code FROM room");
  assert.equal(rows.length, 1);
});

test("a host reconnect within grace clears absence before the alarm", async () => {
  const { stub, hostToken, guestToken, storage } = await room("RECONN01");
  const host = await connect(stub, hostToken);
  const guest = await connect(stub, guestToken);
  host.socket.close();
  await pause();
  await connect(stub, hostToken);
  await pause();
  const marked = await (await storage()).exec("SELECT absent_host FROM room");
  assert.equal(marked[0].absent_host, null);
  await alarm(stub);
  assert.deepEqual(peerLeft(guest.messages), []);
});

test("an alarm after grace tells only the guest and keeps the row", async () => {
  const { stub, hostToken, guestToken, storage } = await room("GRACE001");
  const host = await connect(stub, hostToken);
  const guest = await connect(stub, guestToken);
  host.socket.close();
  await pause();
  const handle = await storage();
  await handle.exec("UPDATE room SET absent_host = ?", Date.now() - RECONNECT_GRACE_MS - 1);
  await alarm(stub);
  assert.equal(peerLeft(guest.messages).length, 1);
  const rows = await handle.exec("SELECT code FROM room");
  assert.equal(rows.length, 1);
});

test("an alarm after expiry deletes the row and reports the reason", async () => {
  const { stub, hostToken, guestToken, storage } = await room("EXPIRE01");
  const host = await connect(stub, hostToken);
  const guest = await connect(stub, guestToken);
  const handle = await storage();
  await handle.exec("UPDATE room SET expires_at = ?", Date.now() - 1_000);
  await alarm(stub);
  const expired = [...host.messages, ...guest.messages].filter((message) => message.type === "expired");
  assert.equal(expired.length >= 1, true);
  assert.equal(expired[0].reason, "idle");
  const rows = await handle.exec("SELECT code FROM room");
  assert.equal(rows.length, 0);
});
