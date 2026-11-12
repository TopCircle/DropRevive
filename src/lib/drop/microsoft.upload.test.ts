import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { RetryableUploadError, type XhrSendFn, type XhrSendResult } from "./upload-retry.ts";

register("./store.test-hooks.mjs", import.meta.url);
const { fake } = await import("./store.test-fakes.ts");
const { CloudError } = await import("./errors.ts");
const { uploadMicrosoftFile, SIMPLE_LIMIT, MICROSOFT_CHUNK_BYTES } = await import("./microsoft.ts");

const sleep = async () => undefined;
const UPLOAD_URL = "https://graph.microsoft.com/upload-session";

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "application/octet-stream" });
}

type GetReply = { status: number; body: unknown } | "cut";

function graphFetch(getReplies: GetReply[] = []): {
  fetch: typeof fetch;
  posts: number;
  gets: number;
} {
  const state = { posts: 0, gets: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("createUploadSession")) {
      state.posts += 1;
      return new Response(JSON.stringify({ uploadUrl: UPLOAD_URL }), { status: 200 });
    }
    if (method === "GET") {
      state.gets += 1;
      assert.equal(url, UPLOAD_URL);
      const reply = getReplies.shift() ?? { status: 200, body: { nextExpectedRanges: ["0-"] } };
      if (reply === "cut") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return {
    fetch: fetchImpl,
    ...state,
    get posts() {
      return state.posts;
    },
    get gets() {
      return state.gets;
    },
  };
}

type Step =
  { status: number; text?: string; progress?: number[] } | { throw: "cut"; progress?: number[] };

type Call = {
  headers: Record<string, string>;
  size: number;
  range: string;
};

function scriptedXhr(steps: Step[]): { xhrSend: XhrSendFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...steps];
  const xhrSend: XhrSendFn = async (input) => {
    const range = input.headers?.["Content-Range"] ?? "";
    const body = input.body;
    calls.push({
      headers: input.headers ?? {},
      size: body instanceof Blob ? body.size : body ? Number.NaN : 0,
      range,
    });
    const step = queue.shift();
    if (!step) throw new Error(`unexpected xhr #${calls.length} ${range}`);
    for (const ratio of step.progress ?? []) input.onProgress?.(ratio);
    if ("throw" in step) throw new RetryableUploadError("cut");
    const result: XhrSendResult = {
      status: step.status,
      text: step.text ?? "",
      header: () => null,
    };
    return result;
  };
  return { xhrSend, calls };
}

function upload(
  body: Blob,
  io: { xhrSend: XhrSendFn; fetch: typeof fetch },
  onProgress?: (ratio: number) => void,
) {
  return uploadMicrosoftFile({
    token: "stale",
    name: "big.bin",
    mime: "application/octet-stream",
    body,
    onProgress,
    io: { xhrSend: io.xhrSend, fetch: io.fetch, sleep },
  });
}

beforeEach(() => fake.reset());

describe("OneDrive large-file upload", () => {
  it("PUTs ~8 MiB fragments aligned to 320 KiB, with an unaligned last slice", async () => {
    const total = MICROSOFT_CHUNK_BYTES + 200;
    assert.ok(total > SIMPLE_LIMIT);
    const { xhrSend, calls } = scriptedXhr([
      { status: 202, text: JSON.stringify({ nextExpectedRanges: [`${MICROSOFT_CHUNK_BYTES}-`] }) },
      {
        status: 201,
        text: JSON.stringify({ id: "m1", lastModifiedDateTime: "2026-01-01T00:00:00Z" }),
      },
    ]);
    const io = graphFetch();
    const out = await upload(blobOf(total), { xhrSend, fetch: io.fetch });
    assert.equal(out.id, "m1");
    assert.equal(out.modifiedTime, "2026-01-01T00:00:00Z");
    assert.equal(io.posts, 1);
    assert.equal(io.gets, 0);
    assert.equal(calls.length, 2);
    assert.equal(MICROSOFT_CHUNK_BYTES % (320 * 1024), 0);
    assert.equal(calls[0]!.size, MICROSOFT_CHUNK_BYTES);
    assert.equal(calls[0]!.range, `bytes 0-${MICROSOFT_CHUNK_BYTES - 1}/${total}`);
    assert.equal(calls[1]!.size, 200);
    assert.equal(calls[1]!.range, `bytes ${MICROSOFT_CHUNK_BYTES}-${total - 1}/${total}`);
  });

  it("GETs nextExpectedRanges after a mid-file failure and resumes from that offset", async () => {
    const total = MICROSOFT_CHUNK_BYTES + 80;
    const { xhrSend, calls } = scriptedXhr([
      { status: 202, text: JSON.stringify({ nextExpectedRanges: [`${MICROSOFT_CHUNK_BYTES}-`] }) },
      { throw: "cut" },
      { status: 201, text: JSON.stringify({ id: "m2" }) },
    ]);
    const io = graphFetch([
      { status: 200, body: { nextExpectedRanges: [`${MICROSOFT_CHUNK_BYTES}-`] } },
    ]);
    const out = await upload(blobOf(total), { xhrSend, fetch: io.fetch });
    assert.equal(out.id, "m2");
    assert.equal(io.gets, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[1]!.range, `bytes ${MICROSOFT_CHUNK_BYTES}-${total - 1}/${total}`);
    assert.equal(calls[2]!.range, calls[1]!.range);
    assert.equal(calls[2]!.size, 80);
  });

  it("does not retry a 4xx fragment and does not GET the session", async () => {
    const total = MICROSOFT_CHUNK_BYTES + 1;
    const { xhrSend, calls } = scriptedXhr([{ status: 400, text: "bad request" }]);
    const io = graphFetch();
    await assert.rejects(
      upload(blobOf(total), { xhrSend, fetch: io.fetch }),
      (error: unknown) => error instanceof CloudError,
    );
    assert.equal(calls.length, 1);
    assert.equal(io.gets, 0);
  });

  it("keeps progress monotonic when a fragment is retried", async () => {
    const total = MICROSOFT_CHUNK_BYTES + 1;
    const seen: number[] = [];
    const { xhrSend } = scriptedXhr([
      { throw: "cut", progress: [0.5] },
      {
        status: 202,
        text: JSON.stringify({ nextExpectedRanges: [`${MICROSOFT_CHUNK_BYTES}-`] }),
        progress: [0.1, 1],
      },
      { status: 201, text: JSON.stringify({ id: "m3" }), progress: [1] },
    ]);
    const io = graphFetch([{ status: 200, body: { nextExpectedRanges: ["0-"] } }]);
    await upload(blobOf(total), { xhrSend, fetch: io.fetch }, (ratio) => seen.push(ratio));
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i]! >= seen[i - 1]!, `progress went backwards: ${seen}`);
    }
    assert.ok(seen[0]! > 0);
    assert.equal(seen[seen.length - 1], 1);
    assert.ok(!seen.includes(0));
  });
});

describe("OneDrive simple upload", () => {
  it("renews the access token once on a 401 and retries", async () => {
    fake.renew = async () => "fresh";
    const { xhrSend, calls } = scriptedXhr([
      { status: 401, text: "expired" },
      {
        status: 200,
        text: JSON.stringify({ id: "s1", lastModifiedDateTime: "2026-02-02T00:00:00Z" }),
      },
    ]);
    const out = await uploadMicrosoftFile({
      token: "stale",
      name: "small.bin",
      mime: "text/plain",
      body: blobOf(16),
      io: { xhrSend, sleep },
    });
    assert.equal(out.id, "s1");
    assert.equal(calls[0]!.headers.Authorization, "Bearer stale");
    assert.equal(calls[1]!.headers.Authorization, "Bearer fresh");
    assert.deepEqual(
      fake.calls.filter((call) => call.op === "renew"),
      [{ drive: "microsoft", op: "renew", arg: "stale" }],
    );
  });

  it("does not retry a 4xx simple upload", async () => {
    const { xhrSend, calls } = scriptedXhr([{ status: 403, text: "no" }]);
    await assert.rejects(
      uploadMicrosoftFile({
        token: "stale",
        name: "small.bin",
        mime: "text/plain",
        body: blobOf(16),
        io: { xhrSend, sleep: async () => assert.fail("must not back off on 4xx") },
      }),
      (error: unknown) => error instanceof CloudError,
    );
    assert.equal(calls.length, 1);
  });
});
