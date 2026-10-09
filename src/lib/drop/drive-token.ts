import { DriveAuthError, DriveSessions, type ChannelLike, type LockManagerLike, type TokenEntry, type TokenReply } from "./drive-session";
import { CloudError } from "./errors";
import { PROVIDER_LABEL, type ProviderId } from "./types";

export type { TokenEntry, TokenReply } from "./drive-session";

/** Mirrors oauth.server.ts; kept apart so no server module lands in the client bundle. */
const BASE = "/api/drive-auth";
/** Background syncs renew this long before expiry, so a visible page never sees the token lapse. */
export const RENEW_AHEAD = 5 * 60_000;

export type Renewed = { provider: ProviderId; accessToken: string; expiresAt: number; who?: string };

type Listener = (provider: ProviderId, renewed: Renewed | null) => void;
let listener: Listener = () => undefined;

/** The store hears every renewal (or a lost sign-in), whoever triggered it. */
export function onRenewal(next: Listener): void {
  listener = next;
}

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== "function") return null;
  // The callback's promise is what request() resolves with.
  return { request: <T>(name: string, callback: () => Promise<T>) => locks.request(name, callback) as unknown as Promise<T> };
}

function browserChannel(): ChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const real = new BroadcastChannel("droprevive-drive-auth");
    const channel: ChannelLike = { postMessage: (message) => real.postMessage(message), onmessage: null };
    real.onmessage = (event) => channel.onmessage?.({ data: event.data });
    return channel;
  } catch {
    return null;
  }
}

const sessions = new DriveSessions({
  post: (path) => fetch(`${BASE}${path}`, { method: "POST", credentials: "same-origin" }),
  locks: browserLocks(),
  channel: browserChannel(),
});

function asCloud(error: unknown): unknown {
  if (!(error instanceof DriveAuthError)) return error;
  if (error.kind === "network") return new CloudError("网络中断了，没能续上网盘登录。恢复后再试。");
  if (error.kind === "http") return new CloudError(`登录服务出错了（${error.status}），过一会儿再试。`);
  if (error.kind === "disconnected") return new CloudError("这个网盘已经断开了。");
  return new CloudError("断开没成功，请重试。");
}

/** Access tokens for both drives (or one). Concurrent callers share a request; tabs take turns. */
export async function fetchDriveTokens(only?: ProviderId, options?: { share?: boolean }): Promise<TokenReply> {
  try {
    return await sessions.fetchTokens(only, options);
  } catch (error) {
    throw asCloud(error);
  }
}

/** Read before a request whose answer may arrive after a disconnect; see `isCurrent`. */
export function driveGeneration(provider: ProviderId): number {
  return sessions.generationOf(provider);
}

/** False once a disconnect started after `generation` was read: drop the answer. */
export function isCurrent(provider: ProviderId, generation: number): boolean {
  return sessions.isCurrent(provider, generation);
}

export function asRenewed(provider: ProviderId, entry: TokenEntry | null): Renewed | null {
  if (!entry || !("access_token" in entry)) return null;
  return {
    provider,
    accessToken: entry.access_token,
    // A minute of slack so a call never goes out with a token about to lapse.
    expiresAt: Date.now() + entry.expires_in * 1000 - 60_000,
    ...(entry.who ? { who: entry.who } : {}),
  };
}

export function entryMessage(provider: ProviderId, entry: TokenEntry | null): string {
  const label = PROVIDER_LABEL[provider];
  if (!entry || ("error" in entry && entry.error === "reauth_required")) return `${label} 的登录过期了，到设置里重新连接一次。`;
  if ("error" in entry && entry.error === "not_configured") return `这个版本还没开通 ${label}，暂时不能用。`;
  return `${label} 暂时续不上登录，过一会儿再试。`;
}

/** Signed out for good (no cookie, or the drive refused it), as opposed to a passing failure. */
export function isSignedOut(entry: TokenEntry | null): boolean {
  return !entry || ("error" in entry && entry.error !== "unavailable" && entry.error !== "stale_grant");
}

/**
 * Fresh access token for one drive; tells the store either way. A disconnect that starts
 * while this waits wins: the answer is dropped and this rejects.
 */
/** A fresh access token through the Worker. Pass `rejected` when the drive just answered 401 to it. */
export async function renewToken(provider: ProviderId, rejected?: string): Promise<string> {
  let entry: TokenEntry | null;
  try {
    entry = await sessions.renew(provider, rejected);
  } catch (error) {
    throw asCloud(error);
  }
  const renewed = asRenewed(provider, entry);
  if (renewed) {
    listener(provider, renewed);
    return renewed.accessToken;
  }
  if (isSignedOut(entry)) listener(provider, null);
  throw new CloudError(entryMessage(provider, entry));
}

/** Full-page trip to the provider; the Worker sends the page back to /?connected=… */
export function startConnect(provider: ProviderId, hint?: string): void {
  const query = hint ? `?hint=${encodeURIComponent(hint)}` : "";
  window.location.assign(`${BASE}/${provider}/start${query}`);
}

/**
 * Forgets this device's sign-in only; the drive keeps its grant for other devices.
 * Waits for refreshes in flight first. Rejects with 「断开没成功，请重试。」 when the
 * Worker didn't confirm, so the caller must not show the drive as disconnected.
 */
export async function driveLogout(provider: ProviderId): Promise<void> {
  try {
    await sessions.disconnect(provider);
  } catch (error) {
    throw asCloud(error);
  }
}
