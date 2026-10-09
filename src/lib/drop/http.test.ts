import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// The real http.ts and microsoft.ts; the Worker's renewToken and local storage are faked
// (store.test-hooks.mjs), and fetch is a fake Graph.
register("./store.test-hooks.mjs", import.meta.url);
let online = true;
Object.defineProperty(globalThis.navigator, "onLine", { get: () => online, configurable: true });
const { fake } = await import("./store.test-fakes.ts");
const { apiFetch } = await import("./http.ts");
const { listMicrosoftMetas } = await import("./microsoft.ts");
const { CloudError } = await import("./errors.ts");

type Reply = { status: number; body?: unknown } | "cut";
let replies: ((url: string, token: string) => Reply)[] = [];
const seen: { url: string; token: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace("Bearer ", "");
  seen.push({ url, token });
  const next = replies.shift();
  const reply = next ? next(url, token) : { status: 404 };
  if (reply === "cut") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
}) as typeof fetch;

beforeEach(() => {
  fake.reset();
  replies = [];
  seen.length = 0;
  online = true;
});

describe("drive requests and the 「网络中断」 warning", () => {
  it("a 401 renews the access token through the Worker and retries: no warning", async () => {
    fake.renew = async () => "fresh";
    replies = [
      () => ({ status: 401, body: { error: { code: "InvalidAuthenticationToken" } } }),
      (_url, token) => ({ status: token === "fresh" ? 200 : 401, body: { value: [{ id: "f1", name: "Work", folder: {} }] } }),
      () => ({ status: 200, body: { value: [] } }),
    ];
    const listed = await listMicrosoftMetas("stale");
    assert.deepEqual(listed.shelves, ["Work"]);
    assert.deepEqual(seen.slice(0, 2).map((call) => call.token), ["stale", "fresh"]);
    assert.deepEqual(fake.calls.filter((call) => call.op === "renew"), [{ drive: "microsoft", op: "renew", arg: "stale" }], "renewed once, naming the refused token");
  });

  it("a read cut off once while online is retried quietly", async () => {
    replies = [() => "cut", () => ({ status: 200, body: { ok: 1 } })];
    const started = Date.now();
    const out = await apiFetch("https://graph.microsoft.com/v1.0/me/drive/root", "t");
    assert.equal(out.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(Date.now() - started >= 1000, "after a short pause");
  });

  it("a real outage (no response twice) shows 「网络中断了」", async () => {
    replies = [() => "cut", () => "cut"];
    await assert.rejects(apiFetch("https://graph.microsoft.com/v1.0/me/drive/root", "t"), (error: unknown) => error instanceof CloudError && /网络中断了/.test(error.message));
    assert.equal(seen.length, 2);
  });

  it("offline shows it at once, and a write is never repeated", async () => {
    online = false;
    replies = [() => "cut"];
    await assert.rejects(apiFetch("https://graph.microsoft.com/v1.0/me/drive/root", "t"), /网络中断了/);
    assert.equal(seen.length, 1);
    online = true;
    replies = [() => "cut", () => ({ status: 201 })];
    await assert.rejects(apiFetch("https://graph.microsoft.com/v1.0/me/drive/items/x/children", "t", { method: "POST" }), /网络中断了/);
    assert.equal(seen.length, 2, "the POST went out once");
  });
});
