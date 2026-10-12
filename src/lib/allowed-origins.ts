/**
 * Which site origins this Worker serves sign-in and LAN pairing for.
 *
 * The list comes from the Worker variable ALLOWED_ORIGINS: comma-separated full
 * origins (scheme + host [+ port]), e.g. "https://drop.example.com,https://staging.example.com".
 * It is set with `wrangler secret put ALLOWED_ORIGINS` so no deployment's address is
 * written into the repo. It is optional:
 *
 * - Unset, empty or `none` → same-origin only: a request is allowed when its origin is the
 *   origin of the request URL itself (the workers.dev address, or any custom domain routed to
 *   this Worker). Nothing has to be configured after a fresh deploy.
 * - One or more valid entries → exactly that list (strict, as before).
 * - Entries present but all malformed → nothing is allowed (fail closed): a typo must not
 *   silently widen access to "same-origin".
 *
 * LOCAL_DEV_ORIGINS stay open in every case; a deployed Worker never sees a plain-http
 * localhost request URL, so that default cannot widen a real deployment.
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
  /** The variable is unset, `none`, or has no non-empty entries: same-origin only. */
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
  const text = (raw ?? "").trim();
  // Placeholders (same rule as runtime-config envValue): treated as unset.
  if (text === "-" || text.toLowerCase() === "none")
    return { origins: [], invalid: [], missing: true };
  const entries = text
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

/**
 * Whether `origin` may use this Worker. `siteOrigin` is the origin of the request URL (the
 * address this Worker was reached on); with no list configured only that origin is allowed.
 */
export function isAllowedOrigin(
  origin: string,
  allowed: AllowedOrigins,
  siteOrigin?: string,
): boolean {
  if (LOCAL_DEV_ORIGINS.includes(origin)) return true;
  if (allowed.missing) return siteOrigin !== undefined && origin === siteOrigin.toLowerCase();
  return allowed.origins.includes(origin);
}

/** What the list means, for /setup and logs: same-origin default, a strict list, or fail-closed. */
export function allowedMode(allowed: AllowedOrigins): "same-origin" | "list" | "malformed" {
  if (allowed.missing) return "same-origin";
  return allowed.origins.length > 0 ? "list" : "malformed";
}

/**
 * One line for the Worker log explaining a refusal. Carries only origins (never cookies,
 * tokens or other request data); the refused origin is clipped.
 */
export function refusalReason(origin: string, allowed: AllowedOrigins): string {
  const shown = origin.slice(0, 200);
  if (allowed.missing)
    return `${shown} refused: not same-origin (${ALLOWED_ORIGINS_VAR} is not set, so only this site's own origin is allowed)`;
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
