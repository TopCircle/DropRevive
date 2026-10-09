import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { GOOGLE_CLIENT_ID, MS_CLIENT_ID } from "./client-env";
import {
  asRenewed,
  driveGeneration,
  entryMessage,
  fetchDriveTokens,
  isCurrent,
  isSignedOut,
  RENEW_AHEAD,
  type Renewed,
  renewToken,
  type TokenReply,
} from "./drive-token";
import type { AuthError, StoreGet, StoreSet } from "./store-core";
import { PROVIDER_LABEL, type GoogleSession, type MicrosoftSession, type ProviderId, type TokenBag } from "./types";

/** The store as applyRenewal needs it: the live store, or a creator's get/set. */
export type StoreApi = { getState: StoreGet; setState: StoreSet };

/** The load-time /token check; syncs wait for it so the first pass uses what the Worker said. */
let sessionsChecked: Promise<void> = Promise.resolve();
/** Longest a sync waits for that check, so a Worker that never answers can't hold syncing back. */
export const SESSION_CHECK_CAP_MS = 10_000;

/** Hold syncs until the load-time /token check settles (hydrate sets this before `hydrated` flips). */
export function holdSyncsUntil(check: Promise<void>): void {
  sessionsChecked = check;
}

export function sessionsReady(): Promise<void> {
  return sessionsChecked;
}

export /** A stored session only counts if it was issued to the client ID this build uses. */
function ownSession<T extends { clientId: string }>(session: T | null | undefined, clientId: string): T | null {
  return session && clientId && session.clientId === clientId ? session : null;
}

export /** Use the stored access token until a few minutes before it lapses, then ask the Worker once. */
async function tokenFor(provider: ProviderId, get: StoreGet): Promise<string | null> {
  const session = get()[provider];
  if (!session) return null;
  if (session.expiresAt > Date.now() + RENEW_AHEAD) return session.accessToken;
  try {
    return await renewToken(provider);
  } catch (error) {
    const now = get()[provider];
    if (now && now.expiresAt > Date.now() + 30_000) return now.accessToken;
    throw error;
  }
}

function sessionFrom(renewed: Renewed, previous: GoogleSession | MicrosoftSession | null): GoogleSession | MicrosoftSession {
  const base = { accessToken: renewed.accessToken, expiresAt: renewed.expiresAt, via: "server" as const };
  if (renewed.provider === "google") {
    const email = renewed.who ?? (previous as GoogleSession | null)?.email;
    return { ...base, clientId: GOOGLE_CLIENT_ID, ...(email ? { email } : {}) };
  }
  const username = renewed.who ?? (previous as MicrosoftSession | null)?.username;
  return { ...base, clientId: MS_CLIENT_ID, ...(username ? { username } : {}) };
}

export function applyRenewal(store: StoreApi, provider: ProviderId, renewed: Renewed | null): void {
  const previous = store.getState()[provider];
  if (!renewed) {
    if (!previous) return;
    store.setState(provider === "google" ? { google: null } : { microsoft: null });
    toast.error(t("auth.signedOut", { provider: PROVIDER_LABEL[provider] }), {
      id: `signed-out-${provider}`,
      duration: 20_000,
      action: { label: t("auth.openSettings"), onClick: () => store.getState().openSettings() },
    });
    return;
  }
  const next = sessionFrom(renewed, previous);
  store.setState(provider === "google" ? { google: next as GoogleSession } : { microsoft: next as MicrosoftSession });
}

export /** Fresh access tokens are enough. Ask the Worker only for a drive that is about to lapse, or right after sign-in. */
function providersToRefresh(
  google: GoogleSession | null,
  microsoft: MicrosoftSession | null,
  returned: ProviderId | null,
  upgraded: boolean,
): ProviderId[] | null {
  if (upgraded) return ["google", "microsoft"];
  const list: ProviderId[] = [];
  if (returned) list.push(returned);
  const stale = (session: { expiresAt: number } | null) => Boolean(session && session.expiresAt <= Date.now() + RENEW_AHEAD);
  if (stale(google) && !list.includes("google")) list.push("google");
  if (stale(microsoft) && !list.includes("microsoft")) list.push("microsoft");
  return list.length ? list : null;
}

export /**
 * Ask the Worker which of these drives this browser is still signed in to.
 * A still-valid access token is left alone, so a sync timer does not verify it.
 */
async function adoptServerSessions(
  get: StoreGet,
  set: StoreSet,
  returned: ProviderId | null,
  ask: ProviderId[],
): Promise<void> {
  if (!navigator.onLine) return;
  const generations = { google: driveGeneration("google"), microsoft: driveGeneration("microsoft") };
  let reply: TokenReply;
  try {
    // Right after a new sign-in, a token another tab shared belongs to the old one.
    reply = await fetchDriveTokens(ask.length === 1 ? ask[0] : undefined, { share: !returned });
  } catch {
    return;
  }
  const store: StoreApi = { getState: get, setState: set };
  let gained = false;
  for (const provider of ask) {
    // Disconnected while this was on the way: the answer must not sign the drive back in.
    if (!isCurrent(provider, generations[provider])) continue;
    const entry = reply[provider];
    const renewed = asRenewed(provider, entry);
    if (renewed) {
      gained ||= !get()[provider];
      applyRenewal(store, provider, renewed);
    } else if (isSignedOut(entry)) {
      applyRenewal(store, provider, null);
    }
  }
  if (returned) {
    if (get()[returned]) toast.success(t("auth.connected", { provider: PROVIDER_LABEL[returned] }));
    else {
      set({
        authError: { provider: returned, code: "no_session", description: entryMessage(returned, reply[returned]) },
        settingsOpen: true,
      });
    }
  }
  if (gained) void get().sync();
}

export /**
 * Sessions from the old in-browser sign-in cannot be renewed here. Drop them once.
 * True when there was something to drop, so the notice shows a single time.
 */
function dropLegacyAuth(tokens: TokenBag): boolean {
  let found = false;
  for (const provider of ["google", "microsoft"] as const) {
    const session = tokens[provider] as { via?: string } | null;
    if (session && session.via !== "server") {
      tokens[provider] = null;
      found = true;
    }
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith("msal.") || key === "droprevive.gis.token" || key === "droprevive.msal.token") {
        if (key === "droprevive.gis.token" || key === "droprevive.msal.token" || key.includes("account")) found = true;
        storage.removeItem(key);
      }
    }
  }
  if (document.cookie.includes("msal.cache.encryption")) document.cookie = "msal.cache.encryption=; Max-Age=0; Path=/";
  return found;
}

export /** The Worker comes back to /?connected=… or /?auth_error=…; read it once and tidy the URL. */
function readAuthReturn(): { connected: ProviderId | null; error: AuthError | null } {
  const url = new URL(window.location.href);
  const provider = url.searchParams.get("p") ?? url.searchParams.get("connected");
  const known: ProviderId | null = provider === "google" || provider === "microsoft" ? provider : null;
  const connected = known && url.searchParams.has("connected") ? known : null;
  const code = url.searchParams.get("auth_error");
  const error: AuthError | null = code && known ? { provider: known, code, description: url.searchParams.get("auth_desc") ?? "" } : null;
  if (url.searchParams.has("connected") || code) {
    for (const key of ["connected", "auth_error", "auth_desc", "p"]) url.searchParams.delete(key);
    const search = url.searchParams.toString();
    window.history.replaceState(window.history.state, "", url.pathname + (search ? `?${search}` : "") + url.hash);
  }
  return { connected, error };
}
