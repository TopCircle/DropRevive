/**
 * Worker settings read at request time (Worker secrets / variables, `process.env` on
 * Workers). The public client IDs used to be baked in at build (VITE_*); they now come from
 * the Worker's GOOGLE_CLIENT_ID / MS_CLIENT_ID, with the build values kept as a fallback so
 * a build made the old way keeps working unchanged.
 *
 * "none" (any case) or "-" counts as not set: the Deploy to Cloudflare form asks for every
 * secret, so a self-hoster using only one drive types "none" for the other.
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

/** Only the keys this app reads, from `process.env` (Workers) or any record. */
export function pickConfigEnv(source: Record<string, string | undefined>): ConfigEnv {
  const env: ConfigEnv = {};
  for (const key of CONFIG_KEYS) env[key] = source[key];
  return env;
}
