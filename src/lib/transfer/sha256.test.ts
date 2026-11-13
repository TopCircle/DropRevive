import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { StreamingSha256 } from "./sha256.ts";

function nodeHex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("StreamingSha256", () => {
  it("matches Node's SHA-256 for empty, short, and multi-block inputs", () => {
    const cases = [
      new Uint8Array(),
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("a".repeat(55)),
      new TextEncoder().encode("a".repeat(56)),
      new TextEncoder().encode("a".repeat(64)),
      new TextEncoder().encode("a".repeat(65)),
      new TextEncoder().encode("The quick brown fox jumps over the lazy dog"),
    ];
    for (const input of cases) {
      const hash = new StreamingSha256();
      hash.update(input);
      assert.equal(hash.hex(), nodeHex(input), `len=${input.byteLength}`);
    }
  });

  it("is the same whether the bytes arrive in one update or many", () => {
    const data = crypto.getRandomValues(new Uint8Array(10_000));
    const one = new StreamingSha256();
    one.update(data);
    const many = new StreamingSha256();
    for (let offset = 0; offset < data.byteLength; ) {
      const end = Math.min(data.byteLength, offset + 1 + (offset % 97));
      many.update(data.subarray(offset, end));
      offset = end;
    }
    assert.equal(many.hex(), one.hex());
    assert.equal(one.hex(), nodeHex(data));
  });
});
