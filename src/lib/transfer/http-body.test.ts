import assert from "node:assert/strict";
import test from "node:test";
import { handleTransferRequest, type TransferHttpEnv } from "../../../server/transfer-http.ts";
import { MAX_HTTP_BODY } from "./limits.ts";

const ORIGIN = "https://staging.example.com";

type Calls = { allow: string[]; created: string[]; joined: string[] };

function fakeEnv(allow = true): { env: TransferHttpEnv; calls: Calls } {
  const calls: Calls = { allow: [], created: [], joined: [] };
  const env: TransferHttpEnv = {
    ALLOWED_ORIGINS: ORIGIN,
    TRANSFER_GATE: {
      getByName: () => ({
        allow: async (kind: string) => {
          calls.allow.push(kind);
          return allow;
        },
      }),
    },
    TRANSFER_ROOM: {
      getByName: (name: string) => ({
        create: async (input) => {
          calls.created.push(input.hostName);
          return { code: name, hostToken: input.hostToken, expiresAt: 1 };
        },
        join: async (input) => {
          calls.joined.push(input.guestName);
          return { guestToken: input.guestToken, hostName: "host", expiresAt: 1 };
        },
        fetch: async () => new Response("ws"),
      }),
    },
  };
  return { env, calls };
}

/** An endless chunked body; `pulled` counts bytes the handler actually read. */
function endlessStream(chunk = 64): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x61));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function post(path: string, body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body,
    // Node needs this for a stream body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

test("a chunked body with no Content-Length is cut off just past the cap", async () => {
  const { env, calls } = fakeEnv();
  const source = endlessStream();
  const request = post("/api/transfer", source.stream);
  assert.equal(request.headers.get("content-length"), null);
  const response = await handleTransferRequest(request, env);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "too-large" });
  assert.ok(source.pulled() <= MAX_HTTP_BODY + 64 * 2, `read ${source.pulled()} bytes`);
  assert.equal(source.cancelled(), true);
  assert.deepEqual(calls.created, []);
});

test("a small declared Content-Length does not let a large body through", async () => {
  const { env, calls } = fakeEnv();
  const source = endlessStream();
  const request = post("/api/transfer/join", source.stream, { "content-length": "20" });
  const response = await handleTransferRequest(request, env);
  assert.equal(response.status, 413);
  assert.ok(source.pulled() <= MAX_HTTP_BODY + 64 * 2);
  assert.deepEqual(calls.joined, []);
});

test("a declared Content-Length over the cap is refused before the rate gate", async () => {
  const { env, calls } = fakeEnv();
  const body = "x".repeat(MAX_HTTP_BODY + 1);
  const response = await handleTransferRequest(post("/api/transfer", body, { "content-length": String(body.length) }), env);
  assert.equal(response.status, 413);
  assert.deepEqual(calls.allow, []);
});

test("a body of exactly the cap is still read", async () => {
  const { env, calls } = fakeEnv();
  const json = JSON.stringify({ deviceName: "phone", pad: "" });
  const padded = JSON.stringify({ deviceName: "phone", pad: "p".repeat(MAX_HTTP_BODY - json.length) });
  assert.equal(new TextEncoder().encode(padded).byteLength, MAX_HTTP_BODY);
  const response = await handleTransferRequest(post("/api/transfer", padded), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.created, ["phone"]);
});

test("normal create and join behave as before", async () => {
  const { env, calls } = fakeEnv();
  const created = await handleTransferRequest(post("/api/transfer", JSON.stringify({ deviceName: " laptop " })), env);
  assert.equal(created.status, 200);
  const room = (await created.json()) as { code: string; hostToken: string };
  assert.match(room.code, /^[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(room.hostToken.length, 64);
  assert.deepEqual(calls.created, ["laptop"]);

  const joined = await handleTransferRequest(post("/api/transfer/join", JSON.stringify({ code: room.code.toLowerCase(), deviceName: "phone" })), env);
  assert.equal(joined.status, 200);
  assert.equal(((await joined.json()) as { code: string }).code, room.code);
  assert.deepEqual(calls.joined, ["phone"]);

  // An object without a name still falls back to the default name; a bad code is still 400.
  const fallback = await handleTransferRequest(post("/api/transfer", "{}"), env);
  assert.equal(fallback.status, 200);
  assert.equal(calls.created.at(-1), "device");
  const blank = await handleTransferRequest(post("/api/transfer", JSON.stringify({ deviceName: "   " })), env);
  assert.equal(blank.status, 200);
  assert.equal(calls.created.at(-1), "device");
  const bad = await handleTransferRequest(post("/api/transfer/join", JSON.stringify({ code: "nope" })), env);
  assert.equal(bad.status, 400);
});

test("rate limiting still applies, and before the body is read", async () => {
  const { env, calls } = fakeEnv(false);
  const source = endlessStream();
  const create = await handleTransferRequest(post("/api/transfer", source.stream), env);
  assert.equal(create.status, 429);
  assert.deepEqual(await create.json(), { error: "rate" });
  assert.equal(source.pulled() <= 64 * 2, true, "the body was not drained");
  const join = await handleTransferRequest(post("/api/transfer/join", JSON.stringify({ code: "T5YUB6Y8" })), env);
  assert.equal(join.status, 429);
  assert.deepEqual(calls.allow, ["create", "join"]);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.joined, []);
});

async function expect400(path: string, body: string | null, error: string): Promise<void> {
  const { env, calls } = fakeEnv();
  const response = await handleTransferRequest(post(path, body), env);
  assert.equal(response.status, 400, `${path} ${body}`);
  assert.deepEqual(await response.json(), { error }, `${path} ${body}`);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.joined, []);
}

test("create rejects malformed bodies with 400 instead of throwing", async () => {
  await expect400("/api/transfer", JSON.stringify({ deviceName: 123 }), "bad-request");
  await expect400("/api/transfer", JSON.stringify({ deviceName: null }), "bad-request");
  await expect400("/api/transfer", JSON.stringify({ deviceName: ["a"] }), "bad-request");
  await expect400("/api/transfer", JSON.stringify({ deviceName: "x".repeat(161) }), "bad-request");
  await expect400("/api/transfer", "[]", "bad-request");
  await expect400("/api/transfer", "null", "bad-request");
  await expect400("/api/transfer", '"phone"', "bad-request");
  await expect400("/api/transfer", "42", "bad-request");
  await expect400("/api/transfer", "not json", "bad-request");
  await expect400("/api/transfer", null, "bad-request");
});

test("join rejects malformed bodies with 400 instead of throwing", async () => {
  await expect400("/api/transfer/join", JSON.stringify({ code: 123 }), "bad-code");
  await expect400("/api/transfer/join", JSON.stringify({ code: null }), "bad-code");
  await expect400("/api/transfer/join", JSON.stringify({ code: { a: 1 } }), "bad-code");
  await expect400("/api/transfer/join", JSON.stringify({}), "bad-code");
  await expect400("/api/transfer/join", JSON.stringify({ deviceName: "phone" }), "bad-code");
  await expect400("/api/transfer/join", JSON.stringify({ code: "T5YUB6Y8", deviceName: 123 }), "bad-request");
  await expect400("/api/transfer/join", "[]", "bad-request");
  await expect400("/api/transfer/join", "null", "bad-request");
  await expect400("/api/transfer/join", "not json", "bad-request");
  await expect400("/api/transfer/join", null, "bad-request");
});

test("extra fields are ignored, as before", async () => {
  const { env, calls } = fakeEnv();
  const created = await handleTransferRequest(post("/api/transfer", JSON.stringify({ deviceName: "laptop", extra: [1], hostToken: "x" })), env);
  assert.equal(created.status, 200);
  const room = (await created.json()) as { code: string; hostToken: string };
  assert.notEqual(room.hostToken, "x");
  assert.deepEqual(calls.created, ["laptop"]);
  const joined = await handleTransferRequest(
    post("/api/transfer/join", JSON.stringify({ code: room.code, deviceName: "phone", guestToken: "x", other: true })),
    env,
  );
  assert.equal(joined.status, 200);
  assert.notEqual(((await joined.json()) as { guestToken: string }).guestToken, "x");
  assert.deepEqual(calls.joined, ["phone"]);
});

test("a 40-character name and a name up to the raw bound still pass through to the room", async () => {
  const { env, calls } = fakeEnv();
  const forty = "n".repeat(40);
  const long = "m".repeat(160);
  assert.equal((await handleTransferRequest(post("/api/transfer", JSON.stringify({ deviceName: forty })), env)).status, 200);
  assert.equal((await handleTransferRequest(post("/api/transfer", JSON.stringify({ deviceName: long })), env)).status, 200);
  assert.deepEqual(calls.created, [forty, long]);
});

/** POST /api/transfer to `site` with Origin `origin`, under a given ALLOWED_ORIGINS value. */
async function createStatus(allowed: string | undefined, site: string, origin: string | null): Promise<number> {
  const { env } = fakeEnv();
  env.ALLOWED_ORIGINS = allowed;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  const response = await handleTransferRequest(
    new Request(`${site}/api/transfer`, { method: "POST", headers, body: JSON.stringify({ deviceName: "a" }) }),
    env,
  );
  return response.status;
}

test("ALLOWED_ORIGINS unset, empty or none: room creation is same-origin only", async () => {
  const workersDev = "https://droprevive-test4.someone.workers.dev";
  const custom = "https://drop.custom.example";
  for (const allowed of [undefined, "", "none", " NONE "]) {
    assert.equal(await createStatus(allowed, workersDev, workersDev), 200, `${allowed} workers.dev`);
    assert.equal(await createStatus(allowed, custom, custom), 200, `${allowed} custom domain`);
    assert.equal(await createStatus(allowed, workersDev, "https://evil.example"), 403);
    assert.equal(await createStatus(allowed, workersDev, "http://droprevive-test4.someone.workers.dev"), 403);
    assert.equal(await createStatus(allowed, workersDev, null), 403);
  }
});

test("ALLOWED_ORIGINS set: strict list (and still same host); malformed-only fails closed", async () => {
  assert.equal(await createStatus(ORIGIN, ORIGIN, ORIGIN), 200);
  const other = "https://droprevive.someone.workers.dev";
  assert.equal(await createStatus(ORIGIN, other, other), 403, "same-origin but not listed");
  assert.equal(await createStatus(`${ORIGIN},${other}`, other, ORIGIN), 403, "listed but not the same host");
  assert.equal(await createStatus("staging.example.com,https://staging.example.com/x", ORIGIN, ORIGIN), 403);
});
