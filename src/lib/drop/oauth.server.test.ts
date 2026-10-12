import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cookieName, handleDriveAuth, seal, unseal, type DriveAuthConfig } from "./oauth.server.ts";

const ORIGIN = "https://staging.example.com";
const KEY = randomBytes(32).toString("base64");

type Call = { url: string; form: URLSearchParams | null; auth: string | null };

/** Fake Google / Microsoft endpoints; `reply` decides each token-endpoint answer. */
function fakeProviders(reply: (form: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    calls.push({ url, form, auth: headers.get("authorization") });
    if (url.includes("/token")) {
      const { status = 200, body } = reply(form!);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) return Response.json({ user: { emailAddress: "a@gmail.com" } });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me")) return Response.json({ userPrincipalName: "a@outlook.com" });
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { calls, fetchMock };
}

function config(fetchMock: typeof fetch, extra: Partial<DriveAuthConfig> = {}): DriveAuthConfig {
  return {
    googleClientId: "g-client",
    googleClientSecret: "g-secret",
    msClientId: "m-client",
    msClientSecret: "m-secret",
    cookieKey: KEY,
    origins: [ORIGIN],
    fetch: fetchMock,
    ...extra,
  };
}

/** Minimal cookie jar: applies Set-Cookie (Max-Age=0 deletes) and renders a Cookie header. */
class Jar {
  values = new Map<string, string>();
  raw = new Map<string, string>();
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      this.raw.set(name, line);
      if (/Max-Age=0\b/.test(line)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function get(path: string, jar?: Jar, origin = ORIGIN): Request {
  return new Request(`${origin}${path}`, { headers: jar ? { cookie: jar.header() } : {} });
}

function post(path: string, jar: Jar, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie: jar.header(), ...headers } });
}

/** start → provider → callback, returning the jar holding the refresh cookie. */
async function connect(provider: "google" | "microsoft", cfg: DriveAuthConfig, jar = new Jar()) {
  const started = await handleDriveAuth(get(`/api/drive-auth/${provider}/start`), cfg);
  jar.take(started);
  const location = new URL(started.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const done = await handleDriveAuth(get(`/api/drive-auth/${provider}/callback?code=CODE&state=${state}`, jar), cfg);
  jar.take(done);
  return { started, location, done, jar };
}

describe("drive-auth start", () => {
  it("sends Google to consent with offline access, PKCE and a sealed state cookie", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/google/start?hint=a%40gmail.com"), config(fetchMock));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const q = Object.fromEntries(location.searchParams);
    assert.equal(q.client_id, "g-client");
    assert.equal(q.redirect_uri, `${ORIGIN}/api/drive-auth/google/callback`);
    assert.equal(q.response_type, "code");
    assert.equal(q.scope, "https://www.googleapis.com/auth/drive.file");
    assert.equal(q.access_type, "offline");
    assert.equal(q.prompt, "consent select_account");
    assert.equal(q.code_challenge_method, "S256");
    assert.match(q.code_challenge!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.state!, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(q.login_hint, "a@gmail.com");
    const [cookie] = response.headers.getSetCookie();
    assert.match(cookie!, /^__Secure-dr-oauth=[A-Za-z0-9_-]+; Path=\/api\/drive-auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("sends Microsoft to /common with response_mode=query and offline_access", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/microsoft/start"), config(fetchMock));
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    const q = Object.fromEntries(location.searchParams);
    assert.equal(q.client_id, "m-client");
    assert.equal(q.redirect_uri, `${ORIGIN}/api/drive-auth/microsoft/callback`);
    assert.equal(q.scope, "offline_access User.Read Files.ReadWrite");
    assert.equal(q.response_mode, "query");
    assert.equal(q.prompt, "select_account");
    assert.equal(q.login_hint, undefined);
  });

  it("goes back home with not_configured when a secret is missing", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/microsoft/start"), config(fetchMock, { msClientSecret: undefined }));
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, `${ORIGIN}/`);
    assert.equal(location.searchParams.get("auth_error"), "not_configured");
    assert.match(location.searchParams.get("auth_desc")!, /还没开通/);
    assert.equal(location.searchParams.get("p"), "microsoft");
    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it("treats none / blank / missing ID, secret or cookie key as not_configured, per drive", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const off: [Partial<DriveAuthConfig>, "google" | "microsoft"][] = [
      [{ googleClientSecret: "none" }, "google"],
      [{ googleClientSecret: " NONE " }, "google"],
      [{ googleClientId: "none" }, "google"],
      [{ googleClientId: "" }, "google"],
      [{ msClientSecret: "-" }, "microsoft"],
      [{ msClientId: undefined }, "microsoft"],
    ];
    for (const [change, provider] of off) {
      const cfg = config(fetchMock, change);
      const response = await handleDriveAuth(get(`/api/drive-auth/${provider}/start`), cfg);
      const location = new URL(response.headers.get("location")!);
      assert.equal(location.searchParams.get("auth_error"), "not_configured", JSON.stringify(change));
      assert.deepEqual(response.headers.getSetCookie(), []);
      // The other drive is unaffected.
      const other = provider === "google" ? "microsoft" : "google";
      const fine = await handleDriveAuth(get(`/api/drive-auth/${other}/start`), cfg);
      assert.notEqual(new URL(fine.headers.get("location")!).searchParams.get("auth_error"), "not_configured");
    }
    // DRIVE_COOKIE_KEY missing, none or not 32 bytes: both drives off, never a 500.
    for (const cookieKey of [undefined, "", "none", "c2hvcnQ=", "not base64 !"]) {
      for (const provider of ["google", "microsoft"] as const) {
        const response = await handleDriveAuth(get(`/api/drive-auth/${provider}/start`), config(fetchMock, { cookieKey }));
        assert.equal(response.status, 302, String(cookieKey));
        assert.equal(new URL(response.headers.get("location")!).searchParams.get("auth_error"), "not_configured");
      }
      const token = await handleDriveAuth(post("/api/drive-auth/token", new Jar()), config(fetchMock, { cookieKey }));
      assert.equal(token.status, 200);
    }
  });

  it("uses plain cookie names and no Secure flag on http://localhost:8080", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/google/start", undefined, "http://localhost:8080"), config(fetchMock));
    const [cookie] = response.headers.getSetCookie();
    assert.match(cookie!, /^dr-oauth=/);
    assert.doesNotMatch(cookie!, /Secure/);
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("redirect_uri"), "http://localhost:8080/api/drive-auth/google/callback");
  });
});

describe("drive-auth callback", () => {
  it("exchanges the code with the PKCE verifier and client secret, then stores a sealed refresh cookie", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: { access_token: "AT1", refresh_token: "RT1", expires_in: 3599 } }));
    const cfg = config(fetchMock);
    const { location, done, jar } = await connect("google", cfg);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), `${ORIGIN}/?connected=google`);
    const exchange = calls.find((call) => call.url === "https://oauth2.googleapis.com/token")!;
    assert.equal(exchange.form!.get("grant_type"), "authorization_code");
    assert.equal(exchange.form!.get("code"), "CODE");
    assert.equal(exchange.form!.get("client_secret"), "g-secret");
    assert.equal(exchange.form!.get("redirect_uri"), `${ORIGIN}/api/drive-auth/google/callback`);
    const verifier = exchange.form!.get("code_verifier")!;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), location.searchParams.get("code_challenge"));
    assert.equal(calls.find((call) => call.url.includes("/drive/v3/about"))!.auth, "Bearer AT1");
    // State cookie gone, refresh cookie present, HttpOnly, 400 days, and it does not contain the token in clear.
    assert.equal(jar.values.has("__Secure-dr-oauth"), false);
    const refresh = jar.raw.get("__Secure-dr-g")!;
    assert.match(refresh, /; Path=\/api\/drive-auth; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/);
    assert.doesNotMatch(refresh, /RT1/);
    const opened = await unseal<{ rt: string; who: string }>(KEY, `__Secure-dr-g|g-client`, jar.values.get("__Secure-dr-g")!);
    assert.equal(opened!.rt, "RT1");
    assert.equal(opened!.who, "a@gmail.com");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    const cfg = config(fetchMock);
    const jar = new Jar();
    jar.take(await handleDriveAuth(get("/api/drive-auth/google/start"), cfg));
    const done = await handleDriveAuth(get("/api/drive-auth/google/callback?code=CODE&state=forged", jar), cfg);
    jar.take(done);
    assert.match(done.headers.get("location")!, /\/\?auth_error=state_mismatch&auth_desc=.+&p=google$/);
    assert.equal(calls.length, 0);
    assert.equal(jar.values.has("__Secure-dr-g"), false);
  });

  it("rejects a callback without the state cookie, or one for the other provider", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    const cfg = config(fetchMock);
    const bare = await handleDriveAuth(get("/api/drive-auth/google/callback?code=CODE&state=x"), cfg);
    assert.match(bare.headers.get("location")!, /auth_error=state_mismatch/);
    const jar = new Jar();
    const started = await handleDriveAuth(get("/api/drive-auth/google/start"), cfg);
    jar.take(started);
    const state = new URL(started.headers.get("location")!).searchParams.get("state");
    const crossed = await handleDriveAuth(get(`/api/drive-auth/microsoft/callback?code=CODE&state=${state}`, jar), cfg);
    assert.match(crossed.headers.get("location")!, /auth_error=state_mismatch.*&p=microsoft$/);
  });

  it("rejects a state cookie older than ten minutes", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    let now = 1_000_000;
    const cfg = config(fetchMock, { now: () => now });
    const jar = new Jar();
    const started = await handleDriveAuth(get("/api/drive-auth/google/start"), cfg);
    jar.take(started);
    now += 601_000;
    const state = new URL(started.headers.get("location")!).searchParams.get("state");
    const done = await handleDriveAuth(get(`/api/drive-auth/google/callback?code=CODE&state=${state}`, jar), cfg);
    assert.match(done.headers.get("location")!, /auth_error=state_mismatch/);
  });

  /** start, then come back to the callback with `query` and the matching state. */
  async function backWith(provider: "google" | "microsoft", query: string, cfg: DriveAuthConfig) {
    const jar = new Jar();
    const started = await handleDriveAuth(get(`/api/drive-auth/${provider}/start`), cfg);
    jar.take(started);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    return handleDriveAuth(get(`/api/drive-auth/${provider}/callback?${query}&state=${state}`, jar), cfg);
  }

  it("with a matching state, passes a known provider error on in our own words and clears the state cookie", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: {} }));
    const done = await backWith("microsoft", "error=access_denied&error_description=%3Cscript%3Euser+said+no", config(fetchMock));
    const location = new URL(done.headers.get("location")!);
    assert.equal(location.searchParams.get("auth_error"), "access_denied");
    assert.equal(location.searchParams.get("auth_desc"), "登录页上没有同意授权。");
    assert.equal(location.searchParams.get("p"), "microsoft");
    assert.doesNotMatch(done.headers.get("location")!, /script|said/);
    assert.match(done.headers.getSetCookie()[0]!, /^__Secure-dr-oauth=; .*Max-Age=0/);
    assert.equal(calls.length, 0);
  });

  it("with a matching state, turns an unknown provider error into provider_error", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const done = await backWith("google", "error=%3Cb%3Eweird%3C%2Fb%3E&error_description=anything", config(fetchMock));
    const location = new URL(done.headers.get("location")!);
    assert.equal(location.searchParams.get("auth_error"), "provider_error");
    assert.equal(location.searchParams.get("auth_desc"), "登录页返回了错误，请重新连接。");
    assert.doesNotMatch(done.headers.get("location")!, /weird|anything/);
  });

  it("checks the state before reading the provider's error, and never echoes it on a mismatch", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: {} }));
    const cfg = config(fetchMock);
    // No state cookie at all (a link someone else crafted).
    const bare = await handleDriveAuth(get("/api/drive-auth/microsoft/callback?error=access_denied&error_description=Click+evil.example"), cfg);
    // A state cookie, but the state in the link is not ours.
    const jar = new Jar();
    jar.take(await handleDriveAuth(get("/api/drive-auth/microsoft/start"), cfg));
    const forged = await handleDriveAuth(get("/api/drive-auth/microsoft/callback?error=server_error&error_description=Click+evil.example&state=forged", jar), cfg);
    for (const done of [bare, forged]) {
      const location = new URL(done.headers.get("location")!);
      assert.equal(location.searchParams.get("auth_error"), "state_mismatch");
      assert.equal(location.searchParams.get("auth_desc"), "登录页停留太久或在别的窗口打开了，请重新连接。");
      assert.doesNotMatch(done.headers.get("location")!, /evil|access_denied|server_error/);
      assert.match(done.headers.getSetCookie()[0]!, /^__Secure-dr-oauth=; .*Max-Age=0/);
    }
    assert.equal(calls.length, 0);
  });

  it("reports a code exchange without a refresh token", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: { access_token: "AT" } }));
    const { done, jar } = await connect("google", config(fetchMock));
    assert.match(done.headers.get("location")!, /auth_error=no_refresh_token/);
    assert.equal(jar.values.has("__Secure-dr-g"), false);
  });
});

describe("drive-auth token", () => {
  it("returns a fresh access token and the account for each connected drive", async () => {
    const { calls, fetchMock } = fakeProviders((form) =>
      form.get("grant_type") === "authorization_code"
        ? { body: { access_token: "AT0", refresh_token: "RT-G", expires_in: 3599 } }
        : { body: { access_token: "AT-fresh", expires_in: 3599 } },
    );
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    const response = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      google: { access_token: "AT-fresh", expires_in: 3599, who: "a@gmail.com" },
      microsoft: null,
    });
    const refresh = calls.at(-1)!;
    assert.equal(refresh.form!.get("grant_type"), "refresh_token");
    assert.equal(refresh.form!.get("refresh_token"), "RT-G");
    assert.equal(refresh.form!.get("client_secret"), "g-secret");
    // Cookie is set again (sliding 400 days) and Google's refresh token is kept.
    jar.take(response);
    const opened = await unseal<{ rt: string }>(KEY, "__Secure-dr-g|g-client", jar.values.get("__Secure-dr-g")!);
    assert.equal(opened!.rt, "RT-G");
  });

  it("keeps the cookie on a first invalid_grant (stale_grant), and clears it only on the ?final=1 ask", async () => {
    let revoked = false;
    const { fetchMock } = fakeProviders((form) =>
      form.get("grant_type") === "authorization_code"
        ? { body: { access_token: "AT0", refresh_token: "RT" } }
        : revoked
          ? { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }
          : { body: { access_token: "AT", expires_in: 3600 } },
    );
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    revoked = true;
    const first = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    assert.deepEqual((await first.json()).google, { error: "stale_grant", description: "invalid_grant" });
    assert.deepEqual(first.headers.getSetCookie(), [], "another tab may have just replaced this cookie: leave it");
    const final = await handleDriveAuth(post("/api/drive-auth/token?final=1", jar), cfg);
    assert.equal((await final.json()).google.error, "reauth_required");
    jar.take(final);
    assert.equal(jar.values.has("__Secure-dr-g"), false);
    const again = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    assert.deepEqual(await again.json(), { google: null, microsoft: null });
  });

  it("clears the cookie at once when the drive wants the user back (interaction_required)", async () => {
    let gone = false;
    const { fetchMock } = fakeProviders((form) =>
      form.get("grant_type") === "authorization_code"
        ? { body: { access_token: "AT0", refresh_token: "RT1" } }
        : gone
          ? { status: 400, body: { error: "interaction_required", error_description: "AADSTS50076" } }
          : { body: { access_token: "AT", refresh_token: "RT2", expires_in: 3600 } },
    );
    const cfg = config(fetchMock);
    const { jar } = await connect("microsoft", cfg);
    gone = true;
    const response = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    assert.equal((await response.json()).microsoft.error, "reauth_required");
    jar.take(response);
    assert.equal(jar.values.has("__Secure-dr-m"), false);
  });

  it("keeps the cookie when the provider is only briefly unavailable", async () => {
    let down = false;
    const { fetchMock } = fakeProviders((form) =>
      form.get("grant_type") === "authorization_code"
        ? { body: { access_token: "AT0", refresh_token: "RT" } }
        : down
          ? { status: 503, body: {} }
          : { body: { access_token: "AT", expires_in: 3600 } },
    );
    const cfg = config(fetchMock);
    const { jar } = await connect("microsoft", cfg);
    down = true;
    const response = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    assert.deepEqual((await response.json()).microsoft, { error: "unavailable", description: "HTTP 503" });
    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it("stores Microsoft's rotated refresh token and uses it next time", async () => {
    let issued = 0;
    const { calls, fetchMock } = fakeProviders(() => {
      issued += 1;
      return { body: { access_token: `AT${issued}`, refresh_token: `RT${issued}`, expires_in: 3600 } };
    });
    const cfg = config(fetchMock);
    const { jar } = await connect("microsoft", cfg); // RT1
    const first = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    jar.take(first);
    assert.deepEqual((await first.json()).microsoft, { access_token: "AT2", expires_in: 3600, who: "a@outlook.com" });
    const second = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    jar.take(second);
    const refreshes = calls.filter((call) => call.form?.get("grant_type") === "refresh_token");
    assert.deepEqual(refreshes.map((call) => call.form!.get("refresh_token")), ["RT1", "RT2"]);
    assert.equal(refreshes[0]!.form!.get("scope"), "offline_access User.Read Files.ReadWrite");
    const opened = await unseal<{ rt: string }>(KEY, "__Secure-dr-m|m-client", jar.values.get("__Secure-dr-m")!);
    assert.equal(opened!.rt, "RT3");
  });

  it("refreshes only the drive asked for with ?p=", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } }));
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    await connect("microsoft", cfg, jar);
    const before = calls.length;
    const response = await handleDriveAuth(post("/api/drive-auth/token?p=microsoft", jar), cfg);
    const body = await response.json();
    assert.equal(body.google, null);
    assert.equal(body.microsoft.access_token, "AT");
    assert.deepEqual(calls.slice(before).map((call) => new URL(call.url).host), ["login.microsoftonline.com"]);
  });

  it("drops a tampered cookie, and a Google cookie can't pass as Microsoft's", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    const sealed = jar.values.get("__Secure-dr-g")!;
    jar.values.set("__Secure-dr-g", sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA"));
    jar.values.set("__Secure-dr-m", sealed);
    const before = calls.length;
    const response = await handleDriveAuth(post("/api/drive-auth/token", jar), cfg);
    const body = await response.json();
    assert.equal(body.google.error, "reauth_required");
    assert.equal(body.microsoft.error, "reauth_required");
    assert.equal(calls.length, before);
    jar.take(response);
    assert.equal(jar.values.size, 0);
  });

  it("refuses token and logout calls from other origins", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    const attempts: Record<string, string>[] = [
      {},
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: ORIGIN, "sec-fetch-site": "same-site" },
    ];
    for (const headers of attempts) {
      const token = await handleDriveAuth(post("/api/drive-auth/token", jar, headers), cfg);
      assert.equal(token.status, 403);
      assert.deepEqual(token.headers.getSetCookie(), []);
      const logout = await handleDriveAuth(post("/api/drive-auth/logout", jar, headers), cfg);
      assert.equal(logout.status, 403);
    }
    // Hosts outside the configured list stay closed.
    const foreign = await handleDriveAuth(new Request("https://other.example.workers.dev/api/drive-auth/google/start"), cfg);
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), { error: "origin_not_allowed" });
    const listed = await handleDriveAuth(new Request(`${ORIGIN}/api/drive-auth/google/start`), cfg);
    assert.notEqual(listed.status, 403);
  });

  it("reads ALLOWED_ORIGINS from allowedOriginsRaw: a set list is strict", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const withVar = config(fetchMock, {
      origins: undefined,
      allowedOriginsRaw: "https://staging.example.com, https://drop.example.com",
    });
    const ok = await handleDriveAuth(new Request("https://staging.example.com/api/drive-auth/google/start"), withVar);
    assert.notEqual(ok.status, 403);
    const other = await handleDriveAuth(new Request("https://drop.example.com/api/drive-auth/google/start"), withVar);
    assert.notEqual(other.status, 403);
    const denied = await handleDriveAuth(new Request("https://evil.example/api/drive-auth/google/start"), withVar);
    assert.equal(denied.status, 403);

    // Local dev works too.
    const local = await handleDriveAuth(new Request("http://localhost:8080/api/drive-auth/google/start"), withVar);
    assert.notEqual(local.status, 403);
  });

  it("ALLOWED_ORIGINS unset, empty or none: same-origin only", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    for (const allowedOriginsRaw of [undefined, null, "", "none", " None "]) {
      const cfg = config(fetchMock, { origins: undefined, allowedOriginsRaw });
      // Any address this Worker is reached on (workers.dev or a custom domain) serves itself.
      for (const host of [ORIGIN, "https://droprevive.someone.workers.dev", "https://drop.custom.example"]) {
        const start = await handleDriveAuth(get("/api/drive-auth/google/start", undefined, host), cfg);
        assert.equal(start.status, 302, `${allowedOriginsRaw} ${host}`);
      }
      // Full sign-in and token refresh with a same-origin POST.
      const { jar } = await connect("google", cfg);
      const token = await handleDriveAuth(post("/api/drive-auth/token?p=google", jar), cfg);
      assert.equal(token.status, 200);
      assert.equal((await token.json()).google.access_token, "AT");
      // A cross-origin POST is still refused.
      const cross = await handleDriveAuth(post("/api/drive-auth/token", jar, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), cfg);
      assert.equal(cross.status, 403);
    }
  });

  it("a list of only malformed ALLOWED_ORIGINS entries fails closed (not same-origin)", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const cfg = config(fetchMock, {
      origins: undefined,
      allowedOriginsRaw: "https://staging.example.com/callback,not-a-url",
    });
    const response = await handleDriveAuth(new Request("https://staging.example.com/api/drive-auth/google/start"), cfg);
    assert.equal(response.status, 403);
  });

  it("GET is not accepted for /token", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/token"), config(fetchMock));
    assert.equal(response.status, 404);
  });
});

describe("drive-auth logout and sealing", () => {
  it("logout clears only that drive's cookie on this device and calls no provider", async () => {
    const { calls, fetchMock } = fakeProviders(() => ({ body: { access_token: "AT", refresh_token: "RT" } }));
    const cfg = config(fetchMock);
    const { jar } = await connect("google", cfg);
    await connect("microsoft", cfg, jar);
    const before = calls.length;
    const response = await handleDriveAuth(post("/api/drive-auth/logout?p=google", jar), cfg);
    assert.equal(response.status, 200);
    jar.take(response);
    assert.deepEqual([...jar.values.keys()], ["__Secure-dr-m"]);
    assert.equal(calls.length, before);
  });

  it("keeps a Microsoft-sized refresh token cookie under 4 KB", async () => {
    // Microsoft consumer refresh tokens run to roughly 1.5-2 KB; take 2.2 KB of token-like text.
    const bigToken = `M.C5${"x".repeat(10)}_BAY.0.U.-${randomBytes(1650).toString("base64url")}`;
    assert.ok(bigToken.length >= 2200);
    const name = cookieName("m", ORIGIN);
    const sealed = await seal(KEY, `${name}|m-client`, { v: 1, rt: bigToken, who: "someone.with.a.long.name@outlook.com", t: Date.now() });
    const header = `${name}=${sealed}; Path=/api/drive-auth; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`;
    assert.ok(header.length < 4096, `Set-Cookie is ${header.length} bytes`);
    console.log(`# MS-sized cookie: token ${bigToken.length} B -> Set-Cookie ${header.length} B`);
  });

  it("a DRIVE_COOKIE_KEY that is not 32 bytes leaves the drives off (not_configured, not a 500)", async () => {
    const { fetchMock } = fakeProviders(() => ({ body: {} }));
    const response = await handleDriveAuth(get("/api/drive-auth/google/start"), config(fetchMock, { cookieKey: "c2hvcnQ=" }));
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("auth_error"), "not_configured");
  });
});
