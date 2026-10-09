/**
 * Browser side of the Worker sign-in (/api/drive-auth), without UI or store imports so
 * node --test can load it. drive-token.ts wires it to fetch, Web Locks and BroadcastChannel.
 *
 * - One refresh per drive at a time across tabs (Web Locks). A tab that waited for the
 *   lock first takes a token another tab just got (BroadcastChannel) instead of spending
 *   Microsoft's rotating refresh token again.
 * - `stale_grant` (the drive refused the refresh token, maybe because another tab just
 *   replaced it): wait a moment and ask once more with ?final=1. Only that answer can end
 *   the sign-in.
 * - Disconnect bumps the drive's generation, so a renewal started before it is dropped,
 *   waits for every refresh still running, and only then asks the Worker to clear the
 *   cookie. The clearing response is the last word.
 */

export type DriveId = "google" | "microsoft";

export type TokenEntry =
  | { access_token: string; expires_in: number; who?: string }
  | { error: "reauth_required" | "unavailable" | "not_configured" | "stale_grant"; description?: string };
export type TokenReply = Record<DriveId, TokenEntry | null>;

export type PostResult = { ok: boolean; status: number; json: () => Promise<unknown> };

export type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export type ChannelLike = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type SessionDeps = {
  /** POST to `/api/drive-auth${path}`; rejects on a network failure. */
  post: (path: string) => Promise<PostResult>;
  /** navigator.locks when the browser has it. */
  locks?: LockManagerLike | null;
  /** A BroadcastChannel shared by this site's tabs. */
  channel?: ChannelLike | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DriveAuthErrorKind = "network" | "http" | "disconnected" | "logout";

export class DriveAuthError extends Error {
  readonly kind: DriveAuthErrorKind;
  readonly status?: number;
  constructor(kind: DriveAuthErrorKind, status?: number) {
    super(kind === "http" ? `drive-auth HTTP ${status}` : `drive-auth ${kind}`);
    this.name = "DriveAuthError";
    this.kind = kind;
    this.status = status;
  }
}

const DRIVES: readonly DriveId[] = ["google", "microsoft"];
/** Wait before the second ask after a stale_grant, so another tab's new cookie has landed. */
export const STALE_RETRY_MS = 1000;
/** A token another tab got counts for this long after it was shared. */
export const SHARE_WINDOW_MS = 2 * 60_000;
/** Shared tokens must have at least this much life left. Matches drive-token's RENEW_AHEAD. */
export const SHARE_MIN_LEFT_MS = 5 * 60_000;
export const LOCK_PREFIX = "droprevive-drive-auth:";

type SharedToken = { access_token: string; expiresAt: number; who?: string; at: number };
type BusMessage =
  | { type: "token"; provider: DriveId; access_token: string; expiresAt: number; who?: string; at: number }
  | { type: "cleared"; provider: DriveId };

function isDrive(value: unknown): value is DriveId {
  return value === "google" || value === "microsoft";
}

export class DriveSessions {
  private readonly deps: SessionDeps;
  private readonly generation: Record<DriveId, number> = { google: 0, microsoft: 0 };
  private readonly disconnecting = new Set<DriveId>();
  private readonly pending: Record<DriveId, Set<Promise<unknown>>> = { google: new Set(), microsoft: new Set() };
  private readonly inflight = new Map<string, Promise<TokenReply>>();
  private readonly shared = new Map<DriveId, SharedToken>();

  constructor(deps: SessionDeps) {
    this.deps = deps;
    if (deps.channel) deps.channel.onmessage = (event) => this.hear(event.data);
  }

  generationOf(provider: DriveId): number {
    return this.generation[provider];
  }

  isDisconnecting(provider: DriveId): boolean {
    return this.disconnecting.has(provider);
  }

  /**
   * Access tokens for both drives (or one). Concurrent callers in this tab share a request.
   * A drive being disconnected is never asked for; its entry is null.
   * `share: false` skips tokens from other tabs (e.g. right after a new sign-in).
   */
  fetchTokens(only?: DriveId, options: { share?: boolean } = {}): Promise<TokenReply> {
    const wanted = (only ? [only] : [...DRIVES]).filter((provider) => !this.disconnecting.has(provider));
    if (wanted.length === 0) return Promise.resolve({ google: null, microsoft: null });
    const key = wanted.length === 2 ? "all" : wanted[0]!;
    const running = this.inflight.get("all") ?? this.inflight.get(key);
    if (running) return running;
    const request = this.withLocks(wanted, () => this.ask(wanted, options.share !== false)).finally(() => {
      this.inflight.delete(key);
      for (const provider of wanted) this.pending[provider].delete(request);
    });
    this.inflight.set(key, request);
    for (const provider of wanted) this.pending[provider].add(request);
    return request;
  }

  /**
   * One drive's entry. Rejects with `disconnected` when a disconnect began before the answer
   * came back; the caller must not use (or store) anything from it. `rejected` is an access
   * token the drive just answered 401 to: it is never handed back from the share cache
   * (a newer one another tab got is still fine).
   */
  async renew(provider: DriveId, rejected?: string): Promise<TokenEntry | null> {
    const started = this.generation[provider];
    if (this.disconnecting.has(provider)) throw new DriveAuthError("disconnected");
    if (rejected && this.shared.get(provider)?.access_token === rejected) this.shared.delete(provider);
    const reply = await this.fetchTokens(provider);
    if (this.generation[provider] !== started || this.disconnecting.has(provider)) throw new DriveAuthError("disconnected");
    return reply[provider];
  }

  /** True when no disconnect started since `generation` was read. */
  isCurrent(provider: DriveId, generation: number): boolean {
    return this.generation[provider] === generation && !this.disconnecting.has(provider);
  }

  /**
   * Forget this device's sign-in for one drive. Waits for refreshes in flight (this tab's
   * directly, other tabs' through the lock) so their cookie writes land before the clear.
   * Rejects with `logout` when the Worker didn't confirm; the cookie may still be there.
   */
  async disconnect(provider: DriveId): Promise<void> {
    this.generation[provider] += 1;
    this.disconnecting.add(provider);
    this.shared.delete(provider);
    try {
      await Promise.allSettled([...this.pending[provider]]);
      const response = await this.withLocks([provider], async () => {
        try {
          return await this.deps.post(`/logout?p=${provider}`);
        } catch {
          throw new DriveAuthError("logout");
        }
      });
      if (!response.ok) throw new DriveAuthError("logout", response.status);
      const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      if (!body || body.ok !== true) throw new DriveAuthError("logout", response.status);
      this.tell({ type: "cleared", provider });
    } finally {
      this.disconnecting.delete(provider);
    }
  }

  // ---------- internals ----------

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((wait) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms);
  }

  /** Nested locks in a fixed order (google, then microsoft), so two tabs can't deadlock. */
  private withLocks<T>(providers: DriveId[], body: () => Promise<T>): Promise<T> {
    const locks = this.deps.locks;
    if (!locks) return body();
    const ordered = DRIVES.filter((provider) => providers.includes(provider));
    const run = (index: number): Promise<T> =>
      index >= ordered.length ? body() : locks.request(`${LOCK_PREFIX}${ordered[index]}`, () => run(index + 1));
    return run(0);
  }

  private fromShare(provider: DriveId): TokenEntry | null {
    const token = this.shared.get(provider);
    if (!token) return null;
    const now = this.now();
    if (now - token.at > SHARE_WINDOW_MS || token.expiresAt - now < SHARE_MIN_LEFT_MS) return null;
    return { access_token: token.access_token, expires_in: Math.floor((token.expiresAt - now) / 1000), ...(token.who ? { who: token.who } : {}) };
  }

  private async post(providers: DriveId[], final: boolean): Promise<TokenReply> {
    const query = new URLSearchParams();
    if (providers.length === 1) query.set("p", providers[0]!);
    if (final) query.set("final", "1");
    const search = query.toString();
    let response: PostResult;
    try {
      response = await this.deps.post(`/token${search ? `?${search}` : ""}`);
    } catch {
      throw new DriveAuthError("network");
    }
    if (!response.ok) throw new DriveAuthError("http", response.status);
    const body = (await response.json()) as Partial<TokenReply>;
    return { google: body.google ?? null, microsoft: body.microsoft ?? null };
  }

  /** Runs with the drives' locks held. */
  private async ask(wanted: DriveId[], share: boolean): Promise<TokenReply> {
    const reply: TokenReply = { google: null, microsoft: null };
    const generations = { ...this.generation };
    let left = wanted;
    if (share) {
      left = [];
      for (const provider of wanted) {
        const entry = this.fromShare(provider);
        if (entry) reply[provider] = entry;
        else left.push(provider);
      }
      if (left.length === 0) return reply;
    }
    const first = await this.post(left, false);
    for (const provider of left) reply[provider] = first[provider];
    const stale = left.filter((provider) => reply[provider] && "error" in reply[provider]! && reply[provider]!.error === "stale_grant");
    if (stale.length) {
      await this.sleep(STALE_RETRY_MS);
      let second: TokenReply | null = null;
      try {
        second = await this.post(stale, true);
      } catch {
        second = null;
      }
      for (const provider of stale) {
        const entry = second?.[provider] ?? null;
        reply[provider] =
          second === null || (entry && "error" in entry && entry.error === "stale_grant")
            ? { error: "unavailable", description: "retry failed" }
            : entry;
      }
    }
    for (const provider of left) {
      const entry = reply[provider];
      if (!entry || !("access_token" in entry)) continue;
      if (this.generation[provider] !== generations[provider]) continue;
      const token: SharedToken = { access_token: entry.access_token, expiresAt: this.now() + entry.expires_in * 1000, at: this.now(), ...(entry.who ? { who: entry.who } : {}) };
      this.shared.set(provider, token);
      this.tell({ type: "token", provider, ...token });
    }
    return reply;
  }

  private tell(message: BusMessage): void {
    try {
      this.deps.channel?.postMessage(message);
    } catch {
      // A closed channel only costs the other tabs a refresh of their own.
    }
  }

  private hear(data: unknown): void {
    const message = data as Partial<BusMessage> | null;
    if (!message || !isDrive(message.provider)) return;
    if (message.type === "cleared") {
      this.shared.delete(message.provider);
      return;
    }
    if (message.type !== "token" || typeof message.access_token !== "string") return;
    if (typeof message.expiresAt !== "number" || typeof message.at !== "number") return;
    if (this.disconnecting.has(message.provider)) return;
    this.shared.set(message.provider, {
      access_token: message.access_token,
      expiresAt: message.expiresAt,
      at: message.at,
      ...(typeof message.who === "string" ? { who: message.who } : {}),
    });
  }
}
