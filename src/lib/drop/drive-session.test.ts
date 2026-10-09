import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DriveAuthError, DriveSessions, type ChannelLike, type LockManagerLike, type SessionDeps } from "./drive-session.ts";
import { handleDriveAuth, type DriveAuthConfig } from "./oauth.server.ts";

// The browser half (drive-session.ts) talking to the real Worker half (oauth.server.ts),
// with one shared cookie jar per browser and fake Google / Microsoft token endpoints.

const ORIGIN = "https://staging.example.com";
const KEY = randomBytes(32).toString("base64");
const M_COOKIE = "__Secure-dr-m";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Jar {
  values = new Map<string, string>();
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index);
      if (/Max-Age=0\b/.test(line)) this.values.delete(name);
      else this.values.set(name, pair!.slice(index + 1));
    }
  }
  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** Microsoft-style refresh tokens: each one works once and is replaced by the next. */
function fakeMicrosoft(options: { slowMs?: number; revoked?: () => boolean } = {}) {
  let serial = 1;
  const live = new Set(["RT1"]);
  const refreshes: string[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://graph.microsoft.com/")) return Response.json({ userPrincipalName: "a@outlook.com" });
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600 });
    const rt = form.get("refresh_token")!;
    refreshes.push(rt);
    if (options.revoked?.() || !live.has(rt)) {
      await wait(30);
      return Response.json({ error: "invalid_grant", error_description: "AADSTS70000: refresh token was already used" }, { status: 400 });
    }
    live.delete(rt);
    serial += 1;
    live.add(`RT${serial}`);
    await wait(options.slowMs ?? 10);
    return Response.json({ access_token: `AT${serial}`, refresh_token: `RT${serial}`, expires_in: 3600 });
  }) as typeof fetch;
  return { fetchMock, refreshes, live };
}

function config(fetchMock: typeof fetch): DriveAuthConfig {
  return { googleClientId: "g", googleClientSecret: "gs", msClientId: "m", msClientSecret: "ms", cookieKey: KEY, origins: [ORIGIN], fetch: fetchMock };
}

/** Signs this browser in to OneDrive through start → callback. */
async function signIn(cfg: DriveAuthConfig, jar: Jar): Promise<void> {
  const started = await handleDriveAuth(new Request(`${ORIGIN}/api/drive-auth/microsoft/start`), cfg);
  jar.take(started);
  const state = new URL(started.headers.get("location")!).searchParams.get("state");
  const done = await handleDriveAuth(new Request(`${ORIGIN}/api/drive-auth/microsoft/callback?code=C&state=${state}`, { headers: { cookie: jar.header() } }), cfg);
  jar.take(done);
  assert.ok(jar.values.has(M_COOKIE));
}

/** Same-origin POSTs from one tab; every tab of a browser shares the jar, like real cookies. */
function poster(cfg: DriveAuthConfig, jar: Jar, log: string[] = [], overrides: { logout?: () => Promise<Response> } = {}): SessionDeps["post"] {
  return async (path) => {
    const kind = path.split("?")[0]!.slice(1);
    log.push(`${kind}:start`);
    if (kind === "logout" && overrides.logout) return overrides.logout();
    const response = await handleDriveAuth(
      new Request(`${ORIGIN}/api/drive-auth${path}`, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: jar.header() } }),
      cfg,
    );
    jar.take(response);
    log.push(`${kind}:done`);
    return response;
  };
}

/** Web Locks stand-in: one holder per name, FIFO, shared by every tab of the browser. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const before = tails.get(name) ?? Promise.resolve();
      const run = before.then(() => callback());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/** BroadcastChannel stand-in: delivers to the other tabs, asynchronously, never to itself. */
function fakeHub() {
  const members: ChannelLike[] = [];
  return () => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(message) {
        for (const other of members) if (other !== channel) queueMicrotask(() => other.onmessage?.({ data: structuredClone(message) }));
      },
    };
    members.push(channel);
    return channel;
  };
}

const quick = { sleep: () => Promise.resolve() };

describe("drive sessions: two tabs refreshing OneDrive", () => {
  it("with locks and a shared channel, the second tab takes the first tab's token and the sign-in survives", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const locks = fakeLocks();
    const join = fakeHub();
    const tabA = new DriveSessions({ post: poster(cfg, jar), locks, channel: join(), ...quick });
    const tabB = new DriveSessions({ post: poster(cfg, jar), locks, channel: join(), ...quick });
    const [a, b] = await Promise.all([tabA.fetchTokens("microsoft"), tabB.fetchTokens("microsoft")]);
    assert.equal((a.microsoft as { access_token: string }).access_token, "AT2");
    assert.equal((b.microsoft as { access_token: string }).access_token, "AT2");
    assert.deepEqual(ms.refreshes, ["RT1"], "only one refresh reached Microsoft");
    assert.ok(jar.values.has(M_COOKIE), "still signed in");
  });

  it("without locks, the tab whose old refresh token was refused asks again and gets in with the newer cookie", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const log: string[] = [];
    const tabA = new DriveSessions({ post: poster(cfg, jar, log), ...quick });
    const tabB = new DriveSessions({ post: poster(cfg, jar, log), ...quick });
    const [a, b] = await Promise.all([tabA.fetchTokens("microsoft"), tabB.fetchTokens("microsoft")]);
    assert.equal((a.microsoft as { access_token: string }).access_token, "AT2");
    assert.equal((b.microsoft as { access_token: string }).access_token, "AT3");
    // Both sent RT1 at once; Microsoft refused the second, which then retried with RT2.
    assert.deepEqual(ms.refreshes, ["RT1", "RT1", "RT2"]);
    assert.ok(jar.values.has(M_COOKIE), "the refused tab did not clear the cookie");
    assert.ok(ms.live.has("RT3"));
  });

  it("a refresh token that is really revoked still ends the sign-in after the one retry", async () => {
    let revoked = false;
    const ms = fakeMicrosoft({ revoked: () => revoked });
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    revoked = true;
    let slept = 0;
    const tab = new DriveSessions({ post: poster(cfg, jar), sleep: async (ms) => void (slept = ms) });
    const reply = await tab.fetchTokens("microsoft");
    assert.equal((reply.microsoft as { error: string }).error, "reauth_required");
    assert.equal(ms.refreshes.length, 2);
    assert.equal(slept, 1000);
    assert.equal(jar.values.has(M_COOKIE), false);
  });

  it("a token shared by another tab is not reused after the share window, or when asked not to", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    let now = 1_000_000;
    const join = fakeHub();
    const tabA = new DriveSessions({ post: poster(cfg, jar), channel: join(), now: () => now, ...quick });
    const tabB = new DriveSessions({ post: poster(cfg, jar), channel: join(), now: () => now, ...quick });
    await tabA.fetchTokens("microsoft");
    await wait(0);
    assert.equal(((await tabB.fetchTokens("microsoft", { share: false })).microsoft as { access_token: string }).access_token, "AT3");
    await wait(0);
    now += 3 * 60_000;
    assert.equal(((await tabA.fetchTokens("microsoft")).microsoft as { access_token: string }).access_token, "AT4");
    assert.deepEqual(ms.refreshes, ["RT1", "RT2", "RT3"]);
  });

  it("after a 401, renew never hands back the token the drive just refused (but a newer shared one is fine)", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const join = fakeHub();
    const tabA = new DriveSessions({ post: poster(cfg, jar), channel: join(), ...quick });
    const tabB = new DriveSessions({ post: poster(cfg, jar), channel: join(), ...quick });
    const first = (await tabA.renew("microsoft")) as { access_token: string };
    assert.equal(first.access_token, "AT2");
    // Within the share window the same token would come back; Graph just said 401 to it.
    const again = (await tabA.renew("microsoft", "AT2")) as { access_token: string };
    assert.equal(again.access_token, "AT3", "a real refresh, not the refused token");
    await wait(0);
    // Tab B holds AT3 from tab A's broadcast; its own rejected token was the older AT2, so AT3 is reused.
    const shared = (await tabB.renew("microsoft", "AT2")) as { access_token: string };
    assert.equal(shared.access_token, "AT3");
    assert.deepEqual(ms.refreshes, ["RT1", "RT2"]);
  });
});

describe("drive sessions: disconnect", () => {
  it("waits for a renewal in flight, drops its answer and clears the cookie last", async () => {
    const ms = fakeMicrosoft({ slowMs: 40 });
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const log: string[] = [];
    const tab = new DriveSessions({ post: poster(cfg, jar, log), locks: fakeLocks(), ...quick });
    const renewal = tab.renew("microsoft");
    await wait(5);
    await tab.disconnect("microsoft");
    await assert.rejects(renewal, (error: unknown) => error instanceof DriveAuthError && error.kind === "disconnected");
    assert.deepEqual(log, ["token:start", "token:done", "logout:start", "logout:done"]);
    assert.equal(jar.values.has(M_COOKIE), false, "the late /token answer did not write the cookie back");
    // Nothing asks again afterwards: no cookie, no refresh.
    assert.deepEqual(await tab.fetchTokens("microsoft"), { google: null, microsoft: null });
    assert.deepEqual(ms.refreshes, ["RT1"]);
  });

  it("waits for another tab's refresh through the lock before clearing", async () => {
    const ms = fakeMicrosoft({ slowMs: 40 });
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const locks = fakeLocks();
    const log: string[] = [];
    const other = new DriveSessions({ post: poster(cfg, jar, log), locks, ...quick });
    const tab = new DriveSessions({ post: poster(cfg, jar, log), locks, ...quick });
    const elsewhere = other.fetchTokens("microsoft");
    await wait(5);
    await tab.disconnect("microsoft");
    await elsewhere;
    assert.deepEqual(log, ["token:start", "token:done", "logout:start", "logout:done"]);
    assert.equal(jar.values.has(M_COOKIE), false);
  });

  it("a renewal asked for while disconnecting never reaches the Worker", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    const log: string[] = [];
    let release!: (response: Response) => void;
    const tab = new DriveSessions({
      post: poster(cfg, jar, log, { logout: () => new Promise<Response>((resolve) => (release = resolve)) }),
      ...quick,
    });
    const leaving = tab.disconnect("microsoft");
    await wait(0);
    assert.equal(tab.isDisconnecting("microsoft"), true);
    await assert.rejects(tab.renew("microsoft"), (error: unknown) => error instanceof DriveAuthError && error.kind === "disconnected");
    assert.deepEqual(await tab.fetchTokens(), { google: null, microsoft: null });
    release(Response.json({ ok: true }));
    await leaving;
    // The "both drives" ask went out for Google only; OneDrive was never refreshed.
    assert.deepEqual(log, ["logout:start", "token:start", "token:done"]);
    assert.deepEqual(ms.refreshes, []);
  });
});

describe("drive sessions: logout failures are not success", () => {
  for (const [label, logout] of [
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["HTTP 500", () => Promise.resolve(Response.json({ error: "server_error" }, { status: 500 }))],
    ["HTTP 403", () => Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 }))],
    ["a 200 without ok", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ] as const) {
    it(`rejects on ${label}, keeps the cookie, and the drive keeps working`, async () => {
      const ms = fakeMicrosoft();
      const cfg = config(ms.fetchMock);
      const jar = new Jar();
      await signIn(cfg, jar);
      const tab = new DriveSessions({ post: poster(cfg, jar, [], { logout }), ...quick });
      await assert.rejects(tab.disconnect("microsoft"), (error: unknown) => error instanceof DriveAuthError && error.kind === "logout");
      assert.equal(tab.isDisconnecting("microsoft"), false);
      assert.ok(jar.values.has(M_COOKIE));
      const entry = await tab.renew("microsoft");
      assert.equal((entry as { access_token: string }).access_token, "AT2");
    });
  }

  it("a confirmed logout resolves and clears only that drive", async () => {
    const ms = fakeMicrosoft();
    const cfg = config(ms.fetchMock);
    const jar = new Jar();
    await signIn(cfg, jar);
    jar.values.set("__Secure-dr-g", "kept");
    const tab = new DriveSessions({ post: poster(cfg, jar), ...quick });
    await tab.disconnect("microsoft");
    assert.deepEqual([...jar.values.keys()], ["__Secure-dr-g"]);
  });
});
