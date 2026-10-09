/**
 * In-memory stand-ins for what store.ts imports from sonner, ./drive-token, ./google,
 * ./microsoft, ./idb, ./client-env and ./secrets (wired up by store.test-hooks.mjs).
 * Each drive is a set of folder names plus meta files; every call is logged so a test
 * can assert that nothing was written to the cloud.
 */
import type { ProviderId, RemoteMeta } from "./types.ts";

type TokenEntry = { access_token: string; expires_in: number; who?: string } | { error: string } | null;
type TokenReply = Record<ProviderId, TokenEntry>;
type Renewed = { provider: ProviderId; accessToken: string; expiresAt: number; who?: string };

type FakeFile = { id: string; text: string; modifiedTime: string; shelf?: string };
type DriveCall = { drive: ProviderId; op: string; arg?: string };

function emptyDrive() {
  return { folders: new Set<string>(), files: new Map<string, FakeFile>() };
}

export const fake = {
  drives: { google: emptyDrive(), microsoft: emptyDrive() },
  calls: [] as DriveCall[],
  storage: new Map<string, unknown>(),
  toasts: [] as { kind: string; message: string }[],
  logout: async (_provider: ProviderId): Promise<void> => {},
  /** The Worker's /token answer at load (adoptServerSessions). */
  tokens: async (_only?: ProviderId): Promise<TokenReply> => ({ google: null, microsoft: null }),
  /** renewToken: a fresh access token, or a rejection. */
  renew: async (provider: ProviderId): Promise<string> => {
    throw new Error(`renewToken(${provider}) is not faked`);
  },
  /** What loadSecret returns for the stored sessions. */
  secret: null as unknown,
  /** While set, listing a drive waits for it (to hold a sync in flight). */
  hold: null as Promise<void> | null,
  /** File ids whose move / delete the drive refuses. */
  failing: new Set<string>(),
  /** Drives whose listing throws this error. */
  listError: {} as Partial<Record<ProviderId, Error>>,
  /** What store.ts registered with onRenewal (kept across reset: the store registers once at load). */
  renewal: null as ((provider: ProviderId, renewed: Renewed | null) => void) | null,
  reset() {
    this.drives = { google: emptyDrive(), microsoft: emptyDrive() };
    this.calls = [];
    this.storage = new Map();
    this.toasts = [];
    this.logout = async () => {};
    this.tokens = async () => ({ google: null, microsoft: null });
    this.renew = async (provider) => {
      throw new Error(`renewToken(${provider}) is not faked`);
    };
    this.secret = null;
    this.hold = null;
    this.failing = new Set();
    this.listError = {};
  },
  /** Cloud writes only (create/move/remove/upload/delete); listing, reading and tokens are not writes. */
  writes(drive?: ProviderId) {
    return this.calls.filter((call) => !["list", "read", "token", "renew"].includes(call.op) && (!drive || call.drive === drive));
  },
};

function log(drive: ProviderId, op: string, arg?: string) {
  fake.calls.push({ drive, op, ...(arg !== undefined ? { arg } : {}) });
}

async function listing(drive: ProviderId): Promise<{ metas: RemoteMeta[]; names: string[] }> {
  log(drive, "list");
  if (fake.hold) await fake.hold;
  const failure = fake.listError[drive];
  if (failure) throw failure;
  const { folders, files } = fake.drives[drive];
  const metas = [...files.values()].map((file) => ({
    id: file.id,
    name: file.id,
    modifiedTime: file.modifiedTime,
    ...(file.shelf ? { shelf: file.shelf } : {}),
  }));
  return { metas, names: [...folders] };
}

function read(drive: ProviderId, id: string): string {
  log(drive, "read", id);
  const file = fake.drives[drive].files.get(id);
  if (!file) throw new Error(`no file ${id}`);
  return file.text;
}

/** Folder ids are "<drive>:<name>", and "<drive>:" for the DropRevive folder itself. */
function folder(drive: ProviderId) {
  return async (_token: string, name?: string): Promise<string> => {
    log(drive, "folder", name ?? "");
    if (name) fake.drives[drive].folders.add(name);
    return `${drive}:${name ?? ""}`;
  };
}

function move(drive: ProviderId) {
  return async (_token: string, fileId: string, folderId: string): Promise<void> => {
    log(drive, "move", `${fileId}->${folderId}`);
    const file = fake.drives[drive].files.get(fileId);
    if (!file || fake.failing.has(fileId)) throw new Error(`move ${fileId} refused`);
    const name = folderId.slice(drive.length + 1);
    if (name) file.shelf = name;
    else delete file.shelf;
  };
}

function remove(drive: ProviderId, op: string) {
  return async (_token: string, fileId: string): Promise<void> => {
    log(drive, op, fileId);
    if (fake.failing.has(fileId) || !fake.drives[drive].files.delete(fileId)) throw new Error(`${op} ${fileId} refused`);
  };
}

function refuse(drive: ProviderId, op: string) {
  return async (_token: string, arg?: string): Promise<never> => {
    log(drive, op, arg);
    throw new Error(`${op} is not faked`);
  };
}

// sonner
export const toast = Object.assign(
  (message: string) => void fake.toasts.push({ kind: "message", message }),
  {
    error: (message: string) => void fake.toasts.push({ kind: "error", message }),
    success: (message: string) => void fake.toasts.push({ kind: "success", message }),
    message: (message: string) => void fake.toasts.push({ kind: "message", message }),
    dismiss: () => undefined,
  },
);

// ./drive-token (the sessions in these tests never expire, so nothing renews)
export const RENEW_AHEAD = 5 * 60_000;
export function asRenewed(provider: ProviderId, entry: TokenEntry) {
  if (!entry || !("access_token" in entry)) return null;
  return { provider, accessToken: entry.access_token, expiresAt: Date.now() + entry.expires_in * 1000, ...(entry.who ? { who: entry.who } : {}) };
}
export const driveGeneration = () => 0;
export const isCurrent = () => true;
export const isSignedOut = (entry: TokenEntry) => !entry || ("error" in entry && entry.error !== "unavailable" && entry.error !== "stale_grant");
export const entryMessage = () => "";
export const onRenewal = (listener: (provider: ProviderId, renewed: Renewed | null) => void) => {
  fake.renewal = listener;
};
export const fetchDriveTokens = (only?: ProviderId) => {
  fake.calls.push({ drive: only ?? "google", op: "token" });
  return fake.tokens(only);
};
export const renewToken = (provider: ProviderId, rejected?: string) => {
  fake.calls.push({ drive: provider, op: "renew", ...(rejected !== undefined ? { arg: rejected } : {}) });
  return fake.renew(provider);
};
export const driveLogout = (provider: ProviderId) => fake.logout(provider);

// ./google
export const googleLayout = async () => {
  const { names } = await listing("google");
  return { roots: ["root"], shelves: names.map((name) => ({ id: `g-${name}`, name })) };
};
export const listGoogleMetas = async () => {
  const { metas } = await listing("google");
  return { metas, complete: true };
};
export const readGoogleText = async (_token: string, id: string) => read("google", id);
export const googleShelfFolder = folder("google");
export const moveGoogleFile = move("google");
export const removeGoogleShelf = refuse("google", "remove");
export const trashGoogleFile = remove("google", "trash");
export const uploadGoogleFile = refuse("google", "upload");
export const downloadGoogleBlob = refuse("google", "download");
export const forgetGoogleFolder = () => undefined;

// ./microsoft
export const listMicrosoftMetas = async () => {
  const { metas, names } = await listing("microsoft");
  return { metas, shelves: names, complete: true };
};
export const readMicrosoftText = async (_token: string, id: string) => read("microsoft", id);
export const ensureMicrosoftShelf = folder("microsoft");
export const moveMicrosoftFile = move("microsoft");
export const removeMicrosoftShelf = refuse("microsoft", "remove");
export const deleteMicrosoftFile = remove("microsoft", "delete");
export const uploadMicrosoftFile = refuse("microsoft", "upload");
export const downloadMicrosoftBlob = refuse("microsoft", "download");
export const forgetMicrosoftFolder = () => undefined;

// ./idb
export const loadItems = async () => [];
export const replaceItems = async () => undefined;
export const cacheBlob = async () => undefined;
export const readCachedBlob = async () => null;
export const clearItemCache = async () => undefined;

// ./client-env
export const GOOGLE_CLIENT_ID = "google-client";
export const MS_CLIENT_ID = "microsoft-client";

// ./secrets
export const loadSecret = async () => structuredClone(fake.secret);
export const saveSecret = async () => undefined;
export function readJson<T>(key: string, fallback: T): T {
  return fake.storage.has(key) ? (structuredClone(fake.storage.get(key)) as T) : fallback;
}
export function writeJson(key: string, value: unknown): void {
  fake.storage.set(key, structuredClone(value));
}
