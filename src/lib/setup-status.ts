/**
 * What /setup shows: for each Worker setting whether it is set (never a secret's value; the
 * public client IDs may be shown), whether DRIVE_COOKIE_KEY is a valid 32-byte key, how
 * ALLOWED_ORIGINS applies to the current origin, and the callback URLs to register.
 *
 * Every setting is optional ("deploy first, configure later"): an unset one is "off" (that
 * drive stays off), not an error. LAN transfer works with nothing set.
 *
 * On the maintainer's production host only a summary is returned (configured or not, how
 * many items need attention): visitors there are users, not self-hosters.
 *
 * No framework or `@/` imports so node --test can load it.
 */
import { allowedMode, isAllowedOrigin, parseAllowedOrigins } from "./allowed-origins.ts";
import {
  type BuildClientIds,
  type ClientConfig,
  type ConfigEnv,
  type ConfigKey,
  cookieKeyState,
  drivesEnabled,
  envValue,
  resolveClientIds,
  type StoreKey,
  type ValueSource,
} from "./runtime-config.ts";

/** Same host as scripts/wrangler-profile.mjs PRODUCTION_HOST (a test keeps them equal). */
export const SUMMARY_ONLY_HOSTS: readonly string[] = ["drop.habor.dpdns.org"];

export const GOOGLE_SCOPE_TEXT = "https://www.googleapis.com/auth/drive.file";
export const AZURE_PERMISSIONS = ["Files.ReadWrite", "User.Read", "offline_access"] as const;

/**
 * ok: set. fallback: client ID from the build. off: not set (optional; that part stays off).
 * same-origin: ALLOWED_ORIGINS not set, so only this site's own origin is allowed (fine).
 * invalid: set but unusable (bad cookie key; origin list that does not include this origin or
 * has only malformed entries, which fails closed).
 */
export type ItemState = "ok" | "fallback" | "off" | "same-origin" | "invalid";

export type SetupItem = {
  key: ConfigKey;
  state: ItemState;
  /** Public client IDs only; secrets never carry a value. */
  value?: string;
  /** Where the value came from (Secrets Store, Worker secret, build value, not set, store error). */
  source: ValueSource;
};

export type DriveReadiness = { google: boolean; microsoft: boolean };

export type SetupDetails = {
  mode: "details";
  origin: string;
  items: SetupItem[];
  originAllowed: boolean;
  /** same-origin: not set; list: strict list; malformed: entries but none valid (fail closed). */
  originMode: "same-origin" | "list" | "malformed";
  allowedCount: number;
  invalidOrigins: number;
  callbacks: { google: string; microsoft: string };
  drives: DriveReadiness;
  ready: boolean;
};

export type SetupSummary = { mode: "summary"; ready: boolean; drives: DriveReadiness; attention: number };

export type SetupStatus = SetupDetails | SetupSummary;

export function callbackUrls(origin: string): { google: string; microsoft: string } {
  return {
    google: `${origin}/api/drive-auth/google/callback`,
    microsoft: `${origin}/api/drive-auth/microsoft/callback`,
  };
}

/** Drives that can sign in on this address: drivesEnabled plus the origin check the broker applies. */
export function readyDrives(env: ConfigEnv, requestUrl: string, build: BuildClientIds = {}): DriveReadiness {
  const origin = new URL(requestUrl).origin;
  const originAllowed = isAllowedOrigin(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS), origin);
  const enabled = drivesEnabled(env, build);
  return { google: originAllowed && enabled.google, microsoft: originAllowed && enabled.microsoft };
}

/** What the page's root loader gets (getClientConfig): public IDs and which drives are on. */
export function clientConfig(env: ConfigEnv, requestUrl: string, build: BuildClientIds = {}): ClientConfig {
  const drives = readyDrives(env, requestUrl, build);
  return { ...resolveClientIds(env, build), googleEnabled: drives.google, msEnabled: drives.microsoft };
}

/** Sources when the caller did not resolve through Secrets Store: Worker value, build ID or not set. */
export function plainSources(env: ConfigEnv, build: BuildClientIds = {}): Record<StoreKey, ValueSource> {
  const of = (value: string | undefined, fallback?: string): ValueSource =>
    envValue(value) ? "worker" : envValue(fallback) ? "build" : "off";
  return {
    GOOGLE_CLIENT_ID: of(env.GOOGLE_CLIENT_ID, build.google),
    GOOGLE_CLIENT_SECRET: of(env.GOOGLE_CLIENT_SECRET),
    MS_CLIENT_ID: of(env.MS_CLIENT_ID, build.microsoft),
    MS_CLIENT_SECRET: of(env.MS_CLIENT_SECRET),
    DRIVE_COOKIE_KEY: of(env.DRIVE_COOKIE_KEY),
  };
}

export function setupStatus(
  env: ConfigEnv,
  requestUrl: string,
  build: BuildClientIds = {},
  sources: Record<StoreKey, ValueSource> = plainSources(env, build),
): SetupStatus {
  const origin = new URL(requestUrl).origin;
  const ids = resolveClientIds(env, build);
  const idState = (fromEnv: string | undefined, resolved: string): ItemState =>
    envValue(fromEnv) ? "ok" : resolved ? "fallback" : "off";
  const secret = (key: ConfigKey): ItemState => (envValue(env[key]) ? "ok" : "off");
  const cookie = cookieKeyState(env.DRIVE_COOKIE_KEY);
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const originMode = allowedMode(allowed);
  const originAllowed = isAllowedOrigin(origin, allowed, origin);

  const items: SetupItem[] = [
    {
      key: "GOOGLE_CLIENT_ID",
      state: idState(env.GOOGLE_CLIENT_ID, ids.googleClientId),
      value: ids.googleClientId || undefined,
      source: sources.GOOGLE_CLIENT_ID,
    },
    { key: "GOOGLE_CLIENT_SECRET", state: secret("GOOGLE_CLIENT_SECRET"), source: sources.GOOGLE_CLIENT_SECRET },
    {
      key: "MS_CLIENT_ID",
      state: idState(env.MS_CLIENT_ID, ids.msClientId),
      value: ids.msClientId || undefined,
      source: sources.MS_CLIENT_ID,
    },
    { key: "MS_CLIENT_SECRET", state: secret("MS_CLIENT_SECRET"), source: sources.MS_CLIENT_SECRET },
    { key: "DRIVE_COOKIE_KEY", state: cookie === "missing" ? "off" : cookie, source: sources.DRIVE_COOKIE_KEY },
    {
      key: "ALLOWED_ORIGINS",
      state: originMode === "same-origin" ? "same-origin" : originAllowed ? "ok" : "invalid",
      source: envValue(env.ALLOWED_ORIGINS) ? "worker" : "off",
    },
  ];
  const drives = readyDrives(env, requestUrl, build);
  const ready = drives.google || drives.microsoft;

  if (SUMMARY_ONLY_HOSTS.includes(new URL(requestUrl).hostname)) {
    const attention = items.filter((item) => item.state === "invalid" || item.source === "store-error").length;
    return { mode: "summary", ready, drives, attention };
  }
  return {
    mode: "details",
    origin,
    items,
    originAllowed,
    originMode,
    allowedCount: allowed.origins.length,
    invalidOrigins: allowed.invalid.length,
    callbacks: callbackUrls(origin),
    drives,
    ready,
  };
}
