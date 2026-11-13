import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { decodeChunk, decodeChunkV2 } from "./protocol.ts";
import { hashSlicedFile, writeFileChunks, type SlicedFile } from "./send-chunks.ts";
import { StreamingSha256 } from "./sha256.ts";
import type { DataChannelLike } from "./session.ts";

function fakeFile(bytes: Uint8Array): SlicedFile & { reads: { start: number; end: number }[] } {
  const reads: { start: number; end: number }[] = [];
  return {
    size: bytes.byteLength,
    reads,
    slice(start, end) {
      reads.push({ start, end });
      return {
        arrayBuffer: async () => bytes.subarray(start, end).slice().buffer,
      };
    },
  };
}

function fakeChannel(): DataChannelLike & { frames: Uint8Array[]; maxMessageSize: number; bufferedAmount: number } {
  const frames: Uint8Array[] = [];
  return {
    readyState: "open",
    binaryType: "arraybuffer",
    frames,
    maxMessageSize: 256 * 1024,
    bufferedAmount: 0,
    send(data) {
      frames.push(new Uint8Array(data as ArrayBuffer));
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
  };
}

describe("writeFileChunks", () => {
  it("reads only slices, never the whole file, and emits v2 frames from a start offset", async () => {
    const payload = new Uint8Array(20_000).map((_, i) => i & 0xff);
    const file = fakeFile(payload);
    const channel = fakeChannel();
    const hasher = new StreamingSha256();
    const progress: number[] = [];
    await writeFileChunks(channel, "ABCDEFGH", file, {
      v2: true,
      start: 5_000,
      chunkBytes: 8_000,
      hasher,
      onProgress: (sent) => progress.push(sent),
    });
    assert.ok(file.reads.length >= 2);
    assert.equal(file.reads[0]?.start, 5_000);
    assert.ok(file.reads.every((read) => read.end - read.start <= 8_000));
    assert.ok(file.reads.every((read) => read.start >= 5_000));
    // Whole-file read would be a single slice(0, 20000) — that must not appear.
    assert.ok(!file.reads.some((read) => read.start === 0 && read.end === payload.byteLength));
    const pieces: Uint8Array[] = [];
    for (const frame of channel.frames) {
      const chunk = decodeChunkV2(frame);
      assert.ok(chunk);
      assert.equal(decodeChunk(frame), null);
      pieces.push(chunk!.bytes);
    }
    const joined = new Uint8Array(15_000);
    let at = 0;
    for (const piece of pieces) {
      joined.set(piece, at);
      at += piece.byteLength;
    }
    assert.equal(at, 15_000);
    assert.deepEqual(Array.from(joined), Array.from(payload.subarray(5_000)));
    assert.equal(hasher.hex(), createHash("sha256").update(payload.subarray(5_000)).digest("hex"));
    assert.equal(progress.at(-1), 20_000);
  });

  it("emits v1 frames when the peer is old", async () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const file = fakeFile(payload);
    const channel = fakeChannel();
    await writeFileChunks(channel, "AB", file, {
      v2: false,
      chunkBytes: 8 * 1024,
      onProgress: () => undefined,
    });
    assert.equal(channel.frames.length, 1);
    assert.ok(decodeChunk(channel.frames[0]!));
    assert.equal(decodeChunkV2(channel.frames[0]!), null);
  });
});

describe("hashSlicedFile", () => {
  it("matches Node's SHA-256 across slices, including the empty file", async () => {
    assert.equal(await hashSlicedFile(fakeFile(new Uint8Array()), 3), createHash("sha256").update(new Uint8Array()).digest("hex"));
    const payload = new Uint8Array(10_000).map((_, i) => (i * 11) & 0xff);
    assert.equal(await hashSlicedFile(fakeFile(payload), 1_024), createHash("sha256").update(payload).digest("hex"));
  });
});
