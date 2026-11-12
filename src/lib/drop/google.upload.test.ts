import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { RetryableUploadError, type XhrSendFn, type XhrSendResult } from "./upload-retry.ts";

register("./store.test-hooks.mjs", import.meta.url);
const { fake } = await import("./store.test-fakes.ts");
const { CloudError } = await import("./errors.ts");
const { uploadGoogleFile, FIVE_MB, GOOGLE_CHUNK_BYTES } = await import("./google.ts");

const sleep = async () => undefined;
const SESSION = "https://www.googleapis.com/upload/session";

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "application/octet-stream" });
}

function sessionFetch(location = SESSION): typeof fetch {
  return async () => new Response(null, { status: 200, headers: { Location: location } });
}

type Step =
  | { status: number; text?: string; range?: string; progress?: number[] }
  | { throw: "cut"; progress?: number[] };

type Call = {
  headers: Record<string, string>;
  size: number;
  range: string;
  isQuery: boolean;
  body: XMLHttpRequestBodyInit | null | undefined;
};

function scriptedXhr(steps: Step[]): { xhrSend: XhrSendFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...steps];
  const xhrSend: XhrSendFn = async (input) => {
    const range = input.headers?.["Content-Range"] ?? "";
    const body = input.body;
    const size = body instanceof Blob ? body.size : body ? Number.NaN : 0;
    const call: Call = {
      headers: input.headers ?? {},
      size,
      range,
      isQuery: range.includes("bytes */") || body == null,
      body,
    };
    calls.push(call);
    const step = queue.shift();
    if (!step) throw new Error(`unexpected xhr #${calls.length} ${range}`);
    for (const ratio of step.progress ?? []) input.onProgress?.(ratio);
    if ("throw" in step) throw new RetryableUploadError("cut");
    const result: XhrSendResult = {
      status: step.status,
      text: step.text ?? "",
      header: (name) => (name.toLowerCase() === "range" ? (step.range ?? null) : null),
    };
    return result;
  };
  return { xhrSend, calls };
}

function upload(
  body: Blob,
  io: { xhrSend: XhrSendFn; fetch?: typeof fetch },
  onProgress?: (ratio: number) => void,
) {
  return uploadGoogleFile({
    token: "stale",
    folderId: "folder",
    name: "big.bin",
    mime: "application/octet-stream",
    body,
    onProgress,
    io: { xhrSend: io.xhrSend, fetch: io.fetch ?? sessionFetch(), sleep },
  });
}

beforeEach(() => fake.reset());

describe("Google Drive resumable upload", () => {
  it("PUTs aligned 8 MiB chunks and allows an unaligned last slice", async () => {
    const total = GOOGLE_CHUNK_BYTES + 100;
    assert.ok(total > FIVE_MB);
    const { xhrSend, calls } = scriptedXhr([
      { status: 308, range: `bytes=0-${GOOGLE_CHUNK_BYTES - 1}` },
      { status: 200, text: JSON.stringify({ id: "g1", modifiedTime: "2026-01-01T00:00:00.000Z" }) },
    ]);
    const out = await upload(blobOf(total), { xhrSend });
    assert.equal(out.id, "g1");
    assert.equal(out.modifiedTime, "2026-01-01T00:00:00.000Z");
    assert.equal(calls.length, 2);
    assert.equal(GOOGLE_CHUNK_BYTES % (256 * 1024), 0);
    assert.equal(calls[0]!.size, GOOGLE_CHUNK_BYTES);
    assert.equal(calls[0]!.range, `bytes 0-${GOOGLE_CHUNK_BYTES - 1}/${total}`);
    assert.equal(calls[1]!.size, 100);
    assert.equal(calls[1]!.range, `bytes ${GOOGLE_CHUNK_BYTES}-${total - 1}/${total}`);
    assert.equal(calls[0]!.isQuery, false);
  });

  it("queries Content-Range bytes */total after a mid-file failure and resumes from the server offset", async () => {
    const total = GOOGLE_CHUNK_BYTES + 50;
    const { xhrSend, calls } = scriptedXhr([
      { status: 308, range: `bytes=0-${GOOGLE_CHUNK_BYTES - 1}` },
      { throw: "cut" },
      { status: 308, range: `bytes=0-${GOOGLE_CHUNK_BYTES - 1}` },
      { status: 200, text: JSON.stringify({ id: "g2" }) },
    ]);
    const out = await upload(blobOf(total), { xhrSend });
    assert.equal(out.id, "g2");
    assert.equal(calls[0]!.range, `bytes 0-${GOOGLE_CHUNK_BYTES - 1}/${total}`);
    assert.equal(calls[1]!.range, `bytes ${GOOGLE_CHUNK_BYTES}-${total - 1}/${total}`);
    assert.equal(calls[1]!.isQuery, false);
    assert.equal(calls[2]!.isQuery, true);
    assert.equal(calls[2]!.range, `bytes */${total}`);
    assert.equal(calls[2]!.body, null);
    assert.equal(calls[3]!.range, `bytes ${GOOGLE_CHUNK_BYTES}-${total - 1}/${total}`);
    assert.equal(calls[3]!.size, 50);
  });

  it("does not retry a 4xx on a chunk and does not query progress", async () => {
    const total = GOOGLE_CHUNK_BYTES + 1;
    const { xhrSend, calls } = scriptedXhr([{ status: 400, text: "bad request" }]);
    await assert.rejects(
      upload(blobOf(total), { xhrSend }),
      (error: unknown) => error instanceof CloudError,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.isQuery, false);
  });

  it("renews the access token once on a 401 and retries the same chunk", async () => {
    fake.renew = async () => "fresh";
    const total = GOOGLE_CHUNK_BYTES + 1;
    const { xhrSend, calls } = scriptedXhr([
      { status: 401, text: "expired" },
      { status: 308, range: `bytes=0-${GOOGLE_CHUNK_BYTES - 1}` },
      { status: 200, text: JSON.stringify({ id: "g3" }) },
    ]);
    const out = await upload(blobOf(total), { xhrSend });
    assert.equal(out.id, "g3");
    assert.equal(calls[0]!.headers.Authorization, "Bearer stale");
    assert.equal(calls[1]!.headers.Authorization, "Bearer fresh");
    assert.deepEqual(
      fake.calls.filter((call) => call.op === "renew"),
      [{ drive: "google", op: "renew", arg: "stale" }],
    );
  });

  it("keeps progress monotonic when a chunk is retried", async () => {
    const total = GOOGLE_CHUNK_BYTES + 1;
    const seen: number[] = [];
    const { xhrSend } = scriptedXhr([
      { throw: "cut", progress: [0.5] },
      { status: 308 },
      { status: 308, range: `bytes=0-${GOOGLE_CHUNK_BYTES - 1}`, progress: [0.1, 1] },
      { status: 200, text: JSON.stringify({ id: "g4" }), progress: [1] },
    ]);
    await upload(blobOf(total), { xhrSend }, (ratio) => seen.push(ratio));
    assert.ok(seen.length >= 2);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i]! >= seen[i - 1]!, `progress went backwards: ${seen}`);
    }
    assert.ok(seen[0]! > 0);
    assert.equal(seen[seen.length - 1], 1);
    assert.ok(!seen.includes(0));
  });
});
