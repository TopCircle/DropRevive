/**
 * Drive sign-in broker (Worker side). Stateless: the only storage is two cookies per
 * browser, each holding a provider refresh token sealed with AES-GCM under the
 * DRIVE_COOKIE_KEY secret. The browser never sees a refresh token; it asks POST /token
 * for a fresh access token and keeps calling Drive / Graph itself, as before.
 *
 *   GET  /api/drive-auth/:p/start?hint=  → provider consent page (code flow + PKCE)
 *   GET  /api/drive-auth/:p/callback     → sets the refresh-token cookie, back to /
 *   POST /api/drive-auth/token[?final=1] → { google, microsoft } access tokens
 *   POST /api/drive-auth/logout?p=       → clears that provider's cookie on this device
 *
 * No framework or `@/` imports so node --test can load it directly.
 */

import {
  isAllowedOrigin,
  malformedWarning,
  parseAllowedOrigins,
  refusalReason,
  warnOnce,
  type AllowedOrigins,
} from "../allowed-origins.ts";
import { cookieKeyState, envValue } from "../runtime-config.ts";

export type DriveProvider = "google" | "microsoft";

export type DriveAuthConfig = {
  googleClientId?: string;
  googleClientSecret?: string;
  msClientId?: string;
  msClientSecret?: string;
  /** base64 of 32 random bytes. */
  cookieKey?: string;
  /** Raw Worker variable ALLOWED_ORIGINS (comma-separated). Prefer this in production. */
  allowedOriginsRaw?: string | null;
  /** Pre-parsed origins for tests; when set, skips parsing allowedOriginsRaw. */
  origins?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
};

export type TokenEntry =
  | { access_token: string; expires_in: number; who?: string }
  | { error: "reauth_required" | "unavailable" | "not_configured" | "stale_grant"; description?: string };

export type TokenReply = Record<DriveProvider, TokenEntry | null>;

export const DRIVE_AUTH_BASE = "/api/drive-auth";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const MS_SCOPE = "offline_access User.Read Files.ReadWrite";

const STATE_TTL_S = 600;
const NOT_CONFIGURED = "这个网盘还没开通：Worker 上缺少它的客户端 ID / 密钥或 DRIVE_COOKIE_KEY，打开 /setup 查看。";
const STATE_MISMATCH = "登录页停留太久或在别的窗口打开了，请重新连接。";

/**
 * Provider errors the callback passes on, each with our own wording. The provider's
 * error_description is never echoed; anything else becomes `provider_error`.
 */
const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "登录页上没有同意授权。",
  consent_required: "需要在登录页同意授权。",
  interaction_required: "需要在登录页再确认一次。",
  login_required: "需要先在登录页登录账号。",
  temporarily_unavailable: "登录服务暂时不可用，过一会儿再试。",
  server_error: "登录服务出错了，过一会儿再试。",
  provider_error: "登录页返回了错误，请重新连接。",
};
/** Browsers cap cookie lifetime at about 400 days; every /token call sets it again. */
const REFRESH_TTL_S = 400 * 24 * 3600;

type ProviderSpec = {
  authorize: string;
  token: string;
  scope: string;
  short: "g" | "m";
  clientId: (config: DriveAuthConfig) => string | undefined;
  clientSecret: (config: DriveAuthConfig) => string | undefined;
  authorizeParams: (hint: string | undefined) => Record<string, string>;
  whoUrl: string;
  who: (json: Record<string, unknown>) => string | undefined;
};

const PROVIDERS: Record<DriveProvider, ProviderSpec> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: GOOGLE_SCOPE,
    short: "g",
    clientId: (config) => config.googleClientId,
    clientSecret: (config) => config.googleClientSecret,
    // consent every time: Google only hands out a refresh token on a consent screen.
    authorizeParams: (hint) => ({ access_type: "offline", prompt: "consent select_account", ...(hint ? { login_hint: hint } : {}) }),
    whoUrl: "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
    who: (json) => {
      const user = json.user as { emailAddress?: unknown } | undefined;
      return typeof user?.emailAddress === "string" ? user.emailAddress : undefined;
    },
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: MS_SCOPE,
    short: "m",
    clientId: (config) => config.msClientId,
    clientSecret: (config) => config.msClientSecret,
    // query, not form_post: the SameSite=Lax state cookie only rides along on a GET.
    authorizeParams: (hint) => ({ response_mode: "query", prompt: "select_account", ...(hint ? { login_hint: hint } : {}) }),
    whoUrl: "https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail",
    who: (json) => {
      const name = json.userPrincipalName ?? json.mail;
      return typeof name === "string" ? name : undefined;
    },
  },
};

function isProvider(value: string | undefined): value is DriveProvider {
  return value === "google" || value === "microsoft";
}

// ---------- encoding + sealing ----------

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(size: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function cookieKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    const raw = fromB64(secret.trim());
    if (raw.byteLength !== 32) throw new Error("DRIVE_COOKIE_KEY must be 32 bytes (base64)");
    key = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(secret, key);
  }
  return key;
}

/** AES-GCM with a random IV; `aad` binds the value to one cookie name and client. */
export async function seal(secret: string, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await cookieKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const packed = new Uint8Array(12 + cipher.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(cipher), 12);
  return b64url(packed);
}

/** null for anything tampered, truncated, sealed under another key or for another cookie. */
export async function unseal<T>(secret: string, aad: string, sealed: string): Promise<T | null> {
  try {
    const packed = fromB64(sealed);
    if (packed.byteLength < 13) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.subarray(0, 12), additionalData: new TextEncoder().encode(aad) },
      await cookieKey(secret),
      packed.subarray(12),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

// ---------- cookies ----------

type StateCookie = { p: DriveProvider; state: string; verifier: string; t: number };
type RefreshCookie = { v: 1; rt: string; who?: string; t: number };

function isSecure(origin: string): boolean {
  return origin.startsWith("https://");
}

/** `__Secure-` over https; plain names on http://localhost, where Safari refuses Secure cookies. */
export function cookieName(kind: "g" | "m" | "oauth", origin: string): string {
  return `${isSecure(origin) ? "__Secure-" : ""}dr-${kind}`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function setCookie(name: string, value: string, maxAge: number, origin: string): string {
  return [
    `${name}=${value}`,
    `Path=${DRIVE_AUTH_BASE}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecure(origin) ? ["Secure"] : []),
  ].join("; ");
}

function clearCookie(name: string, origin: string): string {
  return setCookie(name, "", 0, origin);
}

// ---------- helpers ----------

function refreshAad(provider: DriveProvider, name: string, config: DriveAuthConfig): string {
  return `${name}|${PROVIDERS[provider].clientId(config) ?? ""}`;
}

/**
 * Same rule as runtime-config drivesEnabled: client ID and secret set (not `none`) and a
 * DRIVE_COOKIE_KEY that decodes to 32 bytes. Anything less is not_configured, never a 500.
 */
function configured(provider: DriveProvider, config: DriveAuthConfig): boolean {
  const spec = PROVIDERS[provider];
  return Boolean(
    envValue(spec.clientId(config)) &&
      envValue(spec.clientSecret(config)) &&
      cookieKeyState(config.cookieKey) === "ok",
  );
}

function noStore(headers: Headers): Headers {
  headers.set("cache-control", "no-store");
  return headers;
}

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = noStore(new Headers({ "content-type": "application/json; charset=utf-8" }));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = noStore(new Headers({ location }));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function backHome(origin: string, params: Record<string, string>): string {
  return `${origin}/?${new URLSearchParams(params).toString()}`;
}

/** Token and logout calls must come from our own page (CORS already hides the body from others). */
function sameOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return request.headers.get("origin") === origin;
}

async function postForm(
  config: DriveAuthConfig,
  url: string,
  form: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error page: keep the status.
  }
  return { ok: response.ok, status: response.status, body };
}

async function lookupWho(config: DriveAuthConfig, provider: DriveProvider, accessToken: string): Promise<string | undefined> {
  try {
    const doFetch = config.fetch ?? fetch;
    const response = await doFetch(PROVIDERS[provider].whoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return undefined;
    return PROVIDERS[provider].who((await response.json()) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------- endpoints ----------

async function start(request: Request, provider: DriveProvider, origin: string, config: DriveAuthConfig): Promise<Response> {
  if (!configured(provider, config)) {
    return redirect(backHome(origin, { auth_error: "not_configured", auth_desc: NOT_CONFIGURED, p: provider }));
  }
  const spec = PROVIDERS[provider];
  const now = (config.now ?? Date.now)();
  const state = randomToken(16);
  const verifier = randomToken(32);
  const hint = new URL(request.url).searchParams.get("hint")?.slice(0, 200) || undefined;
  const name = cookieName("oauth", origin);
  const sealed = await seal(config.cookieKey!, name, { p: provider, state, verifier, t: now } satisfies StateCookie);
  const params = new URLSearchParams({
    client_id: spec.clientId(config)!,
    redirect_uri: `${origin}${DRIVE_AUTH_BASE}/${provider}/callback`,
    response_type: "code",
    scope: spec.scope,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...spec.authorizeParams(hint),
  });
  return redirect(`${spec.authorize}?${params.toString()}`, [setCookie(name, sealed, STATE_TTL_S, origin)]);
}

async function callback(request: Request, provider: DriveProvider, origin: string, config: DriveAuthConfig): Promise<Response> {
  const stateName = cookieName("oauth", origin);
  const cookies = [clearCookie(stateName, origin)];
  const fail = (code: string, description = "") =>
    redirect(backHome(origin, { auth_error: code, ...(description ? { auth_desc: description.slice(0, 300) } : {}), p: provider }), cookies);
  if (!configured(provider, config)) return fail("not_configured", NOT_CONFIGURED);
  const url = new URL(request.url);
  // State first: until it matches our cookie, nothing from the query reaches the page.
  const raw = readCookie(request, stateName);
  const saved = raw ? await unseal<StateCookie>(config.cookieKey!, stateName, raw) : null;
  const now = (config.now ?? Date.now)();
  if (!saved || saved.p !== provider || saved.state !== url.searchParams.get("state") || now - saved.t > STATE_TTL_S * 1000) {
    return fail("state_mismatch", STATE_MISMATCH);
  }
  const error = url.searchParams.get("error");
  if (error) {
    const known = Object.hasOwn(CALLBACK_ERRORS, error) ? error : "provider_error";
    return fail(known, CALLBACK_ERRORS[known]);
  }
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");
  const spec = PROVIDERS[provider];
  let exchanged: Awaited<ReturnType<typeof postForm>>;
  try {
    exchanged = await postForm(config, spec.token, {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}${DRIVE_AUTH_BASE}/${provider}/callback`,
      client_id: spec.clientId(config)!,
      client_secret: spec.clientSecret(config)!,
      code_verifier: saved.verifier,
      ...(provider === "microsoft" ? { scope: spec.scope } : {}),
    });
  } catch {
    return fail("token_exchange_failed", "network");
  }
  const accessToken = text(exchanged.body.access_token);
  const refreshToken = text(exchanged.body.refresh_token);
  if (!exchanged.ok || !accessToken) {
    return fail(text(exchanged.body.error) || "token_exchange_failed", text(exchanged.body.error_description) || `HTTP ${exchanged.status}`);
  }
  if (!refreshToken) return fail("no_refresh_token");
  const who = await lookupWho(config, provider, accessToken);
  const name = cookieName(spec.short, origin);
  const sealed = await seal(config.cookieKey!, refreshAad(provider, name, config), { v: 1, rt: refreshToken, who, t: now } satisfies RefreshCookie);
  cookies.push(setCookie(name, sealed, REFRESH_TTL_S, origin));
  return redirect(backHome(origin, { connected: provider }), cookies);
}

async function refreshOne(
  request: Request,
  provider: DriveProvider,
  origin: string,
  config: DriveAuthConfig,
  cookies: string[],
  final: boolean,
): Promise<TokenEntry | null> {
  const spec = PROVIDERS[provider];
  const name = cookieName(spec.short, origin);
  const raw = readCookie(request, name);
  if (!raw) return null;
  if (!configured(provider, config)) return { error: "not_configured" };
  const saved = await unseal<RefreshCookie>(config.cookieKey!, refreshAad(provider, name, config), raw);
  if (!saved?.rt) {
    cookies.push(clearCookie(name, origin));
    return { error: "reauth_required", description: "unreadable cookie" };
  }
  let result: Awaited<ReturnType<typeof postForm>>;
  try {
    result = await postForm(config, spec.token, {
      grant_type: "refresh_token",
      refresh_token: saved.rt,
      client_id: spec.clientId(config)!,
      client_secret: spec.clientSecret(config)!,
      ...(provider === "microsoft" ? { scope: spec.scope } : {}),
    });
  } catch {
    return { error: "unavailable", description: "network" };
  }
  const accessToken = text(result.body.access_token);
  if (!result.ok || !accessToken) {
    const code = text(result.body.error);
    // invalid_grant can also mean another tab just rotated Microsoft's refresh token and the
    // newer cookie is already in this browser. Keep the cookie; the page asks once more with
    // ?final=1, which then sends whatever cookie is newest.
    if (code === "invalid_grant" && !final) {
      return { error: "stale_grant", description: code };
    }
    // Revoked, expired, password reset, consent withdrawn: only a new sign-in helps.
    if (code === "invalid_grant" || code === "interaction_required" || code === "consent_required") {
      cookies.push(clearCookie(name, origin));
      return { error: "reauth_required", description: text(result.body.error_description) || code };
    }
    return { error: "unavailable", description: code || `HTTP ${result.status}` };
  }
  // Microsoft hands out a new refresh token on every use; Google keeps the old one.
  const now = (config.now ?? Date.now)();
  const next: RefreshCookie = { v: 1, rt: text(result.body.refresh_token) || saved.rt, t: now, ...(saved.who ? { who: saved.who } : {}) };
  cookies.push(setCookie(name, await seal(config.cookieKey!, refreshAad(provider, name, config), next), REFRESH_TTL_S, origin));
  return {
    access_token: accessToken,
    expires_in: Number(result.body.expires_in) || 3600,
    ...(saved.who ? { who: saved.who } : {}),
  };
}

async function token(request: Request, origin: string, config: DriveAuthConfig): Promise<Response> {
  if (!sameOrigin(request, origin)) return json({ error: "forbidden" }, 403);
  const params = new URL(request.url).searchParams;
  const only = params.get("p");
  const final = params.get("final") === "1";
  const cookies: string[] = [];
  const want = (provider: DriveProvider) => !only || only === provider;
  const [google, microsoft] = await Promise.all([
    want("google") ? refreshOne(request, "google", origin, config, cookies, final) : null,
    want("microsoft") ? refreshOne(request, "microsoft", origin, config, cookies, final) : null,
  ]);
  return json({ google, microsoft } satisfies TokenReply, 200, cookies);
}

function logout(request: Request, origin: string): Response {
  if (!sameOrigin(request, origin)) return json({ error: "forbidden" }, 403);
  const only = new URL(request.url).searchParams.get("p");
  const cookies: string[] = [];
  if (!only || only === "google") cookies.push(clearCookie(cookieName("g", origin), origin));
  if (!only || only === "microsoft") cookies.push(clearCookie(cookieName("m", origin), origin));
  return json({ ok: true }, 200, cookies);
}

export async function handleDriveAuth(request: Request, config: DriveAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const allowed: AllowedOrigins = config.origins
    ? { origins: config.origins, invalid: [], missing: config.origins.length === 0 }
    : parseAllowedOrigins(config.allowedOriginsRaw);
  const malformed = malformedWarning(allowed);
  if (malformed) warnOnce("drive-auth", malformed);
  // The broker's own origin is the request URL's: with ALLOWED_ORIGINS unset every address this
  // Worker is reached on is allowed (same-origin); POSTs also require a same-origin Origin header.
  if (!isAllowedOrigin(origin, allowed, origin)) {
    warnOnce("drive-auth", refusalReason(origin, allowed));
    return json({ error: "origin_not_allowed" }, 403);
  }
  const parts = url.pathname.slice(DRIVE_AUTH_BASE.length).split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  try {
    if (parts.length === 2 && isProvider(parts[0]) && method === "GET") {
      if (parts[1] === "start") return await start(request, parts[0], origin, config);
      if (parts[1] === "callback") return await callback(request, parts[0], origin, config);
    }
    if (parts.length === 1 && parts[0] === "token" && method === "POST") return await token(request, origin, config);
    if (parts.length === 1 && parts[0] === "logout" && method === "POST") return logout(request, origin);
  } catch (error) {
    // Misconfiguration (e.g. a malformed DRIVE_COOKIE_KEY). Never echo request data.
    return json({ error: "server_error", description: error instanceof Error ? error.message : "error" }, 500);
  }
  return json({ error: "not_found" }, 404);
}
