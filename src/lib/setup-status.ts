/**
 * What /setup shows: for each Worker setting whether it is set (never a secret's value; the
 * public client IDs may be shown), whether DRIVE_COOKIE_KEY is a valid 32-byte key, whether
 * the current origin is listed in ALLOWED_ORIGINS, and the callback URLs to register.
 *
 * On the maintainer's production host only a summary is returned (configured or not, how
 * many items need attention): visitors there are users, not self-hosters.
 *
 * No framework or `@/` imports so node --test can load it.
 */
import { isAllowedOrigin, parseAllowedOrigins } from "./allowed-origins.ts";
import {
  type BuildClientIds,
  type ConfigEnv,
  type ConfigKey,
  cookieKeyState,
  envValue,
  resolveClientIds,
} from "./runtime-config.ts";

/** Same host as scripts/wrangler-profile.mjs PRODUCTION_HOST (a test keeps them equal). */
export const SUMMARY_ONLY_HOSTS: readonly string[] = ["drop.habor.dpdns.org"];

export const GOOGLE_SCOPE_TEXT = "https://www.googleapis.com/auth/drive.file";
export const AZURE_PERMISSIONS = ["Files.ReadWrite", "User.Read", "offline_access"] as const;

export type ItemState = "ok" | "missing" | "invalid" | "fallback";

export type SetupItem = {
  key: ConfigKey;
  state: ItemState;
  /** Public client IDs only; secrets never carry a value. */
  value?: string;
};

export type DriveReadiness = { google: boolean; microsoft: boolean };

export type SetupDetails = {
  mode: "details";
  origin: string;
  items: SetupItem[];
  originAllowed: boolean;
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

export function setupStatus(env: ConfigEnv, requestUrl: string, build: BuildClientIds = {}): SetupStatus {
  const origin = new URL(requestUrl).origin;
  const ids = resolveClientIds(env, build);
  const idState = (fromEnv: string | undefined, resolved: string): ItemState =>
    envValue(fromEnv) ? "ok" : resolved ? "fallback" : "missing";
  const secret = (key: ConfigKey): ItemState => (envValue(env[key]) ? "ok" : "missing");
  const cookie = cookieKeyState(env.DRIVE_COOKIE_KEY);
  const allowed = parseAllowedOrigins(envValue(env.ALLOWED_ORIGINS));
  const originAllowed = isAllowedOrigin(origin, allowed);

  const items: SetupItem[] = [
    { key: "GOOGLE_CLIENT_ID", state: idState(env.GOOGLE_CLIENT_ID, ids.googleClientId), value: ids.googleClientId || undefined },
    { key: "GOOGLE_CLIENT_SECRET", state: secret("GOOGLE_CLIENT_SECRET") },
    { key: "MS_CLIENT_ID", state: idState(env.MS_CLIENT_ID, ids.msClientId), value: ids.msClientId || undefined },
    { key: "MS_CLIENT_SECRET", state: secret("MS_CLIENT_SECRET") },
    { key: "DRIVE_COOKIE_KEY", state: cookie },
    {
      key: "ALLOWED_ORIGINS",
      state: allowed.missing ? "missing" : originAllowed ? "ok" : "invalid",
    },
  ];
  const base = cookie === "ok" && originAllowed;
  const drives = {
    google: base && Boolean(ids.googleClientId) && secret("GOOGLE_CLIENT_SECRET") === "ok",
    microsoft: base && Boolean(ids.msClientId) && secret("MS_CLIENT_SECRET") === "ok",
  };
  const ready = drives.google || drives.microsoft;

  if (SUMMARY_ONLY_HOSTS.includes(new URL(requestUrl).hostname)) {
    const attention = items.filter((item) => item.state === "missing" || item.state === "invalid").length;
    return { mode: "summary", ready, drives, attention };
  }
  return {
    mode: "details",
    origin,
    items,
    originAllowed,
    allowedCount: allowed.origins.length,
    invalidOrigins: allowed.invalid.length,
    callbacks: callbackUrls(origin),
    drives,
    ready,
  };
}
