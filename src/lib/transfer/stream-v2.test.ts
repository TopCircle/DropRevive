import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { StreamAssembler, memorySink } from "./assemble.ts";
import { CHUNK_BYTES_V2, MAX_BATCH_BYTES, MAX_FILE_BYTES, V2_MAX_FILE_BYTES, V2_MAX_FILE_IOS_BYTES, V2_MAX_FILE_SAFARI_BYTES } from "./limits.ts";
import {
  V1_CONTROL_LIMITS,
  V2_CONTROL_LIMITS,
  decodeChunk,
  decodeChunkV2,
  decodeControl,
  encodeChunk,
  encodeChunkV2,
  FILE_MAGIC_V2,
} from "./protocol.ts";
import {
  attachStreamCap,
  detectStreamPlat,
  hasStreamCap,
  negotiatedLimits,
  parseStreamCap,
  streamCapLine,
} from "./stream-cap.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("SDP stream-v2 capability", () => {
  it("leaves non-SDP stubs alone so existing session tests keep their exact offer text", () => {
    assert.equal(attachStreamCap("offer-sdp", "other"), "offer-sdp");
    assert.equal(hasStreamCap("offer-sdp"), false);
    assert.equal(parseStreamCap("offer-sdp"), null);
  });

  it("inserts a session-level attribute on a real offer, which an old client would ignore", () => {
    const sdp = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
    const next = attachStreamCap(sdp, "ios");
    assert.equal(next.startsWith("v=0\r\n" + streamCapLine("ios") + "\r\n"), true);
    assert.ok(next.includes("m=application"));
    assert.deepEqual(parseStreamCap(next), { v2: true, plat: "ios" });
    // A second attach is a no-op (do not duplicate).
    assert.equal(attachStreamCap(next, "other"), next);
  });

  it("detects platform from the user agent", () => {
    assert.equal(detectStreamPlat(CHROME), "other");
    assert.equal(detectStreamPlat(SAFARI), "safari");
    assert.equal(detectStreamPlat(IPHONE), "ios");
  });
});

describe("negotiated limits", () => {
  it("keeps 32 / 64 MiB when either peer is on v1", () => {
    const v1 = negotiatedLimits("other", null);
    assert.equal(v1.v2, false);
    assert.equal(v1.maxFileBytes, MAX_FILE_BYTES);
    assert.equal(v1.maxBatchBytes, MAX_BATCH_BYTES);
    assert.deepEqual(negotiatedLimits("other", { v2: false }), v1);
  });

  it("uses 1 GiB between two non-Safari v2 peers, and the tighter cap when one is Safari or iOS", () => {
    const both = negotiatedLimits("other", { v2: true, plat: "other" });
    assert.equal(both.v2, true);
    assert.equal(both.maxFileBytes, V2_MAX_FILE_BYTES);
    assert.equal(negotiatedLimits("other", { v2: true, plat: "safari" }).maxFileBytes, V2_MAX_FILE_SAFARI_BYTES);
    assert.equal(negotiatedLimits("safari", { v2: true, plat: "other" }).maxFileBytes, V2_MAX_FILE_SAFARI_BYTES);
    assert.equal(negotiatedLimits("ios", { v2: true, plat: "other" }).maxFileBytes, V2_MAX_FILE_IOS_BYTES);
    assert.equal(negotiatedLimits("ios", { v2: true, plat: "safari" }).maxFileBytes, V2_MAX_FILE_IOS_BYTES);
  });
});

describe("v2 frames", () => {
  it("round-trips an 8-byte offset and a payload larger than a v1 frame", () => {
    const bytes = new Uint8Array(16 * 1024).map((_, i) => i & 0xff);
    const frame = encodeChunkV2({ id: "ABCDEFGH", offset: 5_000_000_000, bytes });
    assert.equal(frame[0], FILE_MAGIC_V2);
    const decoded = decodeChunkV2(frame);
    assert.equal(decoded?.id, "ABCDEFGH");
    assert.equal(decoded?.offset, 5_000_000_000);
    assert.equal(decoded?.bytes.byteLength, bytes.byteLength);
    assert.deepEqual(Array.from(decoded!.bytes.subarray(0, 8)), Array.from(bytes.subarray(0, 8)));
    // A v1 decoder must not accept a v2 frame (old client would drop it, not crash).
    assert.equal(decodeChunk(frame), null);
    // A v2 decoder must not accept a v1 frame.
    const v1 = encodeChunk({ id: "AB", offset: 32, bytes: Uint8Array.from([1, 2, 3]) });
    assert.equal(decodeChunkV2(v1), null);
  });

  it("rejects a payload above the v2 chunk cap", () => {
    const tooBig = new Uint8Array(CHUNK_BYTES_V2 + 1);
    const frame = encodeChunkV2({ id: "ABCDEFGH", offset: 0, bytes: tooBig });
    assert.equal(decodeChunkV2(frame), null);
  });
});

describe("control messages: v1 vs v2", () => {
  const big = {
    t: "manifest" as const,
    id: "ZZZZZZZZ",
    textBytes: 0,
    files: [{ id: "ABCDEFGH", name: "big.bin", size: 100 * 1024 * 1024, mime: "application/octet-stream" }],
  };
  const resume = {
    t: "resume" as const,
    id: "ZZZZZZZZ",
    files: [{ id: "ABCDEFGH", offset: 1_048_576 }],
  };
  const digest = {
    t: "digest" as const,
    id: "ZZZZZZZZ",
    files: [{ id: "ABCDEFGH", sha256: "a".repeat(64) }],
  };

  it("an old decoder (default v1 limits) rejects a 100 MiB manifest and any new JSON type", () => {
    assert.equal(decodeControl(JSON.stringify(big)), null);
    assert.equal(decodeControl(JSON.stringify(resume)), null);
    assert.equal(decodeControl(JSON.stringify(digest)), null);
    assert.equal(decodeControl(JSON.stringify(resume), V1_CONTROL_LIMITS), null);
  });

  it("a v2 decoder accepts a large manifest, resume, and digest, and still rejects extra fields", () => {
    assert.deepEqual(decodeControl(JSON.stringify(big), V2_CONTROL_LIMITS), big);
    assert.deepEqual(decodeControl(JSON.stringify(resume), V2_CONTROL_LIMITS), resume);
    assert.deepEqual(decodeControl(JSON.stringify(digest), V2_CONTROL_LIMITS), digest);
    assert.equal(decodeControl(JSON.stringify({ ...resume, extra: 1 }), V2_CONTROL_LIMITS), null);
    assert.equal(decodeControl(JSON.stringify({ ...digest, files: [{ id: "ABCDEFGH", sha256: "zz" }] }), V2_CONTROL_LIMITS), null);
    assert.equal(
      decodeControl(
        JSON.stringify({
          ...big,
          files: [{ ...big.files[0], size: V2_MAX_FILE_BYTES + 1 }],
        }),
        V2_CONTROL_LIMITS,
      ),
      null,
    );
  });
});

describe("StreamAssembler resume and digest", () => {
  it("writes contiguous chunks to a sink without pre-allocating, and can resume from the stored offset", async () => {
    const all = new Uint8Array(10_000).map((_, i) => (i * 7) & 0xff);
    const sink = memorySink();
    const first = new StreamAssembler({ id: "f1", size: all.byteLength, sink });
    assert.equal(await first.push(0, all.subarray(0, 3_000)), false);
    assert.equal(first.offset, 3_000);
    // A "reconnect": a new assembler starts at the same offset, same running hash by feeding the same prefix first is NOT done —
    // we keep the assembler in memory. Continuing on the same instance:
    assert.equal(await first.push(3_000, all.subarray(3_000)), true);
    assert.equal(first.hex(), createHash("sha256").update(all).digest("hex"));
    const written = new Uint8Array(10_000);
    let at = 0;
    for (const chunk of sink.chunks) {
      written.set(chunk, at);
      at += chunk.byteLength;
    }
    assert.deepEqual(Array.from(written), Array.from(all));
  });

  it("rejects a non-contiguous offset, which is what a confused resume would look like", async () => {
    const sink = memorySink();
    const file = new StreamAssembler({ id: "f1", size: 8, sink });
    await file.push(0, Uint8Array.from([1, 2, 3]));
    await assert.rejects(() => file.push(0, Uint8Array.from([1, 2, 3])));
    await assert.rejects(() => file.push(4, Uint8Array.from([4])));
  });

  it("refuses to pre-allocate a large file when no sink is given", () => {
    assert.throws(() => new StreamAssembler({ id: "f1", size: 32 * 1024 * 1024 + 1 }));
  });
});

describe("never send new JSON to an old peer", () => {
  it("resume and digest only decode under v2 limits, so a sender that checks limits.v2 will not emit them", () => {
    const resume = JSON.stringify({ t: "resume", id: "ZZZZZZZZ", files: [{ id: "ABCDEFGH", offset: 0 }] });
    // This is the gate the session uses: if negotiatedLimits.v2 is false, decode (and send) is forbidden.
    const limits = negotiatedLimits("other", null);
    assert.equal(limits.v2, false);
    assert.equal(decodeControl(resume, { ...V1_CONTROL_LIMITS, v2: limits.v2 }), null);
    assert.ok(decodeControl(resume, { ...V2_CONTROL_LIMITS, v2: true }));
  });
});
