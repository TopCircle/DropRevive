import assert from "node:assert/strict";
import test from "node:test";
import { decodeChunk, decodeControl, decodeSignal, encodeChunk, encodeSignal } from "./protocol.ts";

test("signal offer round-trips and drops oversized payloads", () => {
  const token = "a".repeat(32);
  const message = { type: "signal" as const, token, payload: { kind: "offer" as const, sdp: "v=0", gen: 1, fresh: true } };
  assert.deepEqual(decodeSignal(encodeSignal(message)), message);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "x".repeat(20_000) } })), null);
  assert.equal(decodeSignal("not-json"), null);
});

test("file chunk keeps id, offset, and bytes", () => {
  const frame = encodeChunk({ id: "AB", offset: 32, bytes: Uint8Array.from([9, 8, 7]) });
  assert.equal(frame[0], 0xc1);
  assert.deepEqual(decodeChunk(frame), { id: "AB", offset: 32, bytes: Uint8Array.from([9, 8, 7]) });
  assert.equal(decodeChunk(Uint8Array.from([0])), null);
});

test("candidate signaling keeps sdpMid and rejects a bare string", () => {
  const token = "a".repeat(32);
  const init = { candidate: "candidate:1 1 UDP 2122260223 192.168.1.9 53421 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "u" };
  const message = { type: "signal" as const, token, payload: { kind: "candidate" as const, init, gen: 1 } };
  assert.deepEqual(decodeSignal(encodeSignal(message)), message);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "candidate", candidate: init.candidate } })), null);
});

test("lease round-trips without a device name and hello still decodes", () => {
  const token = "a".repeat(32);
  const lease = { type: "lease" as const, token };
  assert.deepEqual(decodeSignal(encodeSignal(lease)), lease);
  assert.equal("deviceName" in (decodeSignal(encodeSignal(lease)) ?? {}), false);
  const hello = { type: "hello" as const, token, deviceName: "phone" };
  assert.deepEqual(decodeSignal(encodeSignal(hello)), hello);
});

test("signal descriptions require a generation and offers require fresh", () => {
  const token = "a".repeat(32);
  const offer = { kind: "offer" as const, sdp: "v=0", gen: 2, fresh: true };
  assert.deepEqual(decodeSignal(encodeSignal({ type: "signal", token, payload: offer })), { type: "signal", token, payload: offer });
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "v=0", fresh: true } })), null);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "v=0", gen: 2 } })), null);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "v=0", gen: 0, fresh: true } })), null);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "v=0", gen: 256, fresh: true } })), null);
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "offer", sdp: "v=0", gen: 1.5, fresh: true } })), null);
  const answer = { kind: "answer" as const, sdp: "v=0", gen: 2 };
  assert.deepEqual(decodeSignal(encodeSignal({ type: "signal", token, payload: answer })), { type: "signal", token, payload: answer });
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "answer", sdp: "v=0" } })), null);
  const init = { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 };
  assert.deepEqual(
    decodeSignal(encodeSignal({ type: "signal", token, payload: { kind: "candidate", init, gen: 2 } })),
    { type: "signal", token, payload: { kind: "candidate", init, gen: 2 } },
  );
  assert.equal(decodeSignal(JSON.stringify({ type: "signal", token, payload: { kind: "candidate", init } })), null);
});

test("control messages reject extra fields and oversized manifest text", () => {
  const manifest = { t: "manifest" as const, id: "ZZZZZZZZ", textBytes: 3, files: [{ id: "ABCDEFGH", name: "a.txt", size: 3, mime: "text/plain" }] };
  assert.deepEqual(decodeControl(JSON.stringify(manifest)), manifest);
  assert.equal(decodeControl(JSON.stringify({ ...manifest, extra: 1 })), null);
  assert.equal(decodeControl(JSON.stringify({ t: "manifest", id: "ZZZZZZZZ", textBytes: 100_000, files: [] })), null);
  assert.equal(decodeControl(JSON.stringify({ t: "manifest", textBytes: 3, files: [] })), null);
  assert.deepEqual(decodeControl(JSON.stringify({ t: "accept", id: "ZZZZZZZZ" })), { t: "accept", id: "ZZZZZZZZ" });
  assert.deepEqual(decodeControl(JSON.stringify({ t: "complete", id: "ZZZZZZZZ" })), { t: "complete", id: "ZZZZZZZZ" });
  assert.equal(decodeControl(JSON.stringify({ t: "accept" })), null);
  assert.equal(decodeControl(JSON.stringify({ t: "accept", id: "ZZZZZZZZ", ok: true })), null);
});

test("cancel carries only the direct-failed reason", () => {
  const token = "a".repeat(32);
  const failed = { type: "cancel" as const, token, reason: "direct-failed" as const };
  assert.deepEqual(decodeSignal(encodeSignal(failed)), failed);
  assert.deepEqual(decodeSignal(JSON.stringify({ type: "cancel", token, reason: "other" })), { type: "cancel", token });
  assert.deepEqual(decodeSignal(encodeSignal({ type: "cancel", token })), { type: "cancel", token });
});
