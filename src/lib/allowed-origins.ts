/**
 * Which site origins this Worker serves sign-in and LAN pairing for.
 *
 * The list comes from the Worker variable ALLOWED_ORIGINS: comma-separated full
 * origins (scheme + host [+ port]), e.g. "https://drop.example.com,https://staging.example.com".
 * It is set with `wrangler secret put ALLOWED_ORIGINS` so no deployment's address is
 * written into the repo.
 *
 * Missing, empty or entirely malformed → no deployed origin is allowed (fail closed).
 * Only LOCAL_DEV_ORIGINS stay open; a deployed Worker never sees a plain-http localhost
 * request URL, so that default cannot widen a real deployment.
 *
 * No framework or `@/` imports so node --test, the Nitro server and the route can share it.
 */

export const ALLOWED_ORIGINS_VAR = "ALLOWED_ORIGINS";

/** `npm run dev` works without the variable. */
export const LOCAL_DEV_ORIGINS: readonly string[] = ["http://localhost:8080"];

export type AllowedOrigins = {
  /** Normalised origins from the variable (lower-case, no trailing slash). */
  origins: readonly string[];
  /** Entries that were not a bare http(s) origin; they allow nothing. */
  invalid: readonly string[];
  /** The variable is unset or has no non-empty entries. */
  missing: boolean;
};

/** The origin an entry names, or null when it is not exactly `scheme://host[:port]`. */
function normaliseEntry(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  // "https://a.example/x" parses with pathname "/x"; "https://a.example/?" leaves a
  // trailing "?" that URL drops. Require the text itself to be the origin.
  if (entry.replace(/\/$/, "").toLowerCase() !== url.origin) return null;
  return url.origin;
}

export function parseAllowedOrigins(raw: string | null | undefined): AllowedOrigins {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const origin = normaliseEntry(entry);
    if (origin === null) invalid.push(entry);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid, missing: entries.length === 0 };
}

export function isAllowedOrigin(origin: string, allowed: AllowedOrigins): boolean {
  return LOCAL_DEV_ORIGINS.includes(origin) || allowed.origins.includes(origin);
}

/**
 * One line for the Worker log explaining a refusal. Carries only origins (never cookies,
 * tokens or other request data); the refused origin is clipped.
 */
export function refusalReason(origin: string, allowed: AllowedOrigins): string {
  const shown = origin.slice(0, 200);
  if (allowed.missing) return `${shown} refused: ${ALLOWED_ORIGINS_VAR} is not set on this Worker`;
  if (allowed.origins.length === 0) {
    return `${shown} refused: ${ALLOWED_ORIGINS_VAR} has no valid origin (${allowed.invalid.length} malformed entr${allowed.invalid.length === 1 ? "y" : "ies"})`;
  }
  return `${shown} refused: not listed in ${ALLOWED_ORIGINS_VAR} (${allowed.origins.length} configured)`;
}

/** Malformed entries, for a one-time warning. Entries are origins the operator typed, not secrets. */
export function malformedWarning(allowed: AllowedOrigins): string | null {
  if (allowed.invalid.length === 0) return null;
  const list = allowed.invalid.map((entry) => JSON.stringify(entry.slice(0, 100))).join(", ");
  return `${ALLOWED_ORIGINS_VAR} ignores entries that are not a bare https://host[:port] origin: ${list}`;
}

const warned = new Set<string>();

/** console.warn each distinct message once per isolate, so a misconfiguration is visible but not noisy. */
export function warnOnce(scope: string, message: string): void {
  const line = `[${scope}] ${message}`;
  if (warned.has(line)) return;
  if (warned.size < 100) warned.add(line);
  console.warn(line);
}
