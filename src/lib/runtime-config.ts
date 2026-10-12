/**
 * Worker settings read at request time (Worker secrets / variables, `process.env` on
 * Workers). The public client IDs used to be baked in at build (VITE_*); they now come from
 * the Worker's GOOGLE_CLIENT_ID / MS_CLIENT_ID, with the build values kept as a fallback so
 * a build made the old way keeps working unchanged.
 *
 * Every setting is optional, so a fresh deploy works with none of them ("deploy first, configure
 * later"). "none" (any case) or "-" counts as not set. A drive is on only when its client ID,
 * its client secret and a valid DRIVE_COOKIE_KEY are all set (drivesEnabled); LAN transfer
 * needs none of them.
 *
 * No framework or `@/` imports so node --test, the routes and server functions can share it.
 */

export const CONFIG_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "DRIVE_COOKIE_KEY",
  "ALLOWED_ORIGINS",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigEnv = Partial<Record<ConfigKey, string | undefined>>;

/** The value, trimmed, or "" when unset or a placeholder. */
export function envValue(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value || value === "-" || value.toLowerCase() === "none") return "";
  return value;
}

export type ClientIds = { googleClientId: string; msClientId: string };
export type BuildClientIds = { google?: string; microsoft?: string };

/** Worker value first, then the build-time VITE_* value, else "". */
export function resolveClientIds(env: ConfigEnv, build: BuildClientIds = {}): ClientIds {
  return {
    googleClientId: envValue(env.GOOGLE_CLIENT_ID) || envValue(build.google),
    msClientId: envValue(env.MS_CLIENT_ID) || envValue(build.microsoft),
  };
}

export type CookieKeyState = "missing" | "invalid" | "ok";

/** Whether DRIVE_COOKIE_KEY decodes (base64 or base64url) to exactly 32 bytes. Never returns the key. */
export function cookieKeyState(raw: string | null | undefined): CookieKeyState {
  const value = envValue(raw);
  if (!value) return "missing";
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return "invalid";
  try {
    const normal = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
    return binary.length === 32 ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}

export type DriveFlags = { google: boolean; microsoft: boolean };

/**
 * Which drives this Worker can sign in to: client ID (Worker or build value) + client secret +
 * a 32-byte DRIVE_COOKIE_KEY. The cookie key seals both drives' refresh tokens, so without a
 * valid one both are off. The drive-auth broker (oauth.server.ts) applies the same rule.
 */
export function drivesEnabled(env: ConfigEnv, build: BuildClientIds = {}): DriveFlags {
  const ids = resolveClientIds(env, build);
  const cookie = cookieKeyState(env.DRIVE_COOKIE_KEY) === "ok";
  return {
    google: cookie && Boolean(ids.googleClientId) && Boolean(envValue(env.GOOGLE_CLIENT_SECRET)),
    microsoft: cookie && Boolean(ids.msClientId) && Boolean(envValue(env.MS_CLIENT_SECRET)),
  };
}

/** What the page gets: the public IDs plus whether each drive can actually sign in here. */
export type ClientConfig = ClientIds & { googleEnabled: boolean; msEnabled: boolean };

/** Only the keys this app reads, as plain strings, from the Worker env or any record. */
export function pickConfigEnv(source: Record<string, unknown>): ConfigEnv {
  const env: ConfigEnv = {};
  for (const key of CONFIG_KEYS) {
    const value = source[key];
    env[key] = typeof value === "string" ? value : undefined;
  }
  return env;
}

/**
 * Settings that may come from Cloudflare Secrets Store (account-level, shared between Workers of
 * one account). ALLOWED_ORIGINS is per site and not secret, so it stays a plain Worker setting.
 */
export const STORE_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "DRIVE_COOKIE_KEY",
] as const;
export type StoreKey = (typeof STORE_KEYS)[number];

/** Binding name of a Secrets Store secret: SS_<KEY> (a binding must not share a Worker secret's name). */
export const STORE_BINDING_PREFIX = "SS_";

/**
 * Where a value came from. store: Secrets Store binding. worker: Worker secret / variable.
 * build: build-time VITE_* client ID. off: not set. store-error: the binding exists but get()
 * threw (missing secret, wrong scope or store): treated as unset, so the drive stays off.
 */
export type ValueSource = "store" | "worker" | "build" | "off" | "store-error";

export type ResolvedConfig = { env: ConfigEnv; sources: Record<StoreKey, ValueSource> };

type SecretBinding = { get(): Promise<string> };

function isSecretBinding(value: unknown): value is SecretBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as SecretBinding).get === "function";
}

/** Per-isolate cache of Secrets Store reads, so get() does not run on every request. */
export const STORE_CACHE_MS = 60_000;
type CacheEntry = { at: number; binding: SecretBinding; ok: boolean; value: string };
const storeCache = new Map<string, CacheEntry>();

/** Tests only: forget cached Secrets Store reads. */
export function clearStoreCache(): void {
  storeCache.clear();
}

async function readStore(
  name: string,
  binding: SecretBinding,
  now: number,
  ttlMs: number,
): Promise<{ ok: boolean; value: string }> {
  const cached = storeCache.get(name);
  if (cached && cached.binding === binding && now - cached.at < ttlMs) return cached;
  let entry: CacheEntry;
  try {
    const value = await binding.get();
    entry = { at: now, binding, ok: true, value: typeof value === "string" ? value : "" };
  } catch {
    entry = { at: now, binding, ok: false, value: "" };
  }
  storeCache.set(name, entry);
  return entry;
}

/**
 * The settings this request uses, as plain strings, with where each came from. Per key: the
 * Secrets Store binding SS_<KEY> if the Worker has one (a throw counts as unset: "store-error";
 * an empty or `none` value falls through), else the plain Worker secret, else (client IDs only)
 * the build value. ALLOWED_ORIGINS is always the plain Worker setting. Store reads are cached per
 * isolate for STORE_CACHE_MS, so a rotated store value takes up to a minute to apply.
 */
export async function resolveConfigEnv(
  source: Record<string, unknown>,
  build: BuildClientIds = {},
  options: { now?: number; ttlMs?: number } = {},
): Promise<ResolvedConfig> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? STORE_CACHE_MS;
  const plain = pickConfigEnv(source);
  const env: ConfigEnv = { ALLOWED_ORIGINS: plain.ALLOWED_ORIGINS };
  const sources = {} as Record<StoreKey, ValueSource>;
  const buildValue: Partial<Record<StoreKey, string | undefined>> = {
    GOOGLE_CLIENT_ID: build.google,
    MS_CLIENT_ID: build.microsoft,
  };
  await Promise.all(
    STORE_KEYS.map(async (key) => {
      const name = STORE_BINDING_PREFIX + key;
      const binding = source[name];
      if (isSecretBinding(binding)) {
        const read = await readStore(name, binding, now, ttlMs);
        if (!read.ok) {
          env[key] = undefined;
          sources[key] = "store-error";
          return;
        }
        if (envValue(read.value)) {
          env[key] = read.value;
          sources[key] = "store";
          return;
        }
      }
      if (envValue(plain[key])) {
        env[key] = plain[key];
        sources[key] = "worker";
      } else {
        env[key] = undefined;
        sources[key] = envValue(buildValue[key]) ? "build" : "off";
      }
    }),
  );
  return { env, sources };
}
