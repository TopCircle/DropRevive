/**
 * The pure half of a drive sync: merge a listing into local records, then make the drive
 * match local folder intent. No browser or network imports, so it runs under `node --test`
 * with a fake drive; the store passes the real listing, reader and folder operations.
 */
import { parseMeta, recordFromMeta } from "./meta.ts";
import type { CloudRef, DropRecord, ProviderId, RemoteMeta, Scope, Shelf } from "./types.ts";

/** What one drive listed: its metas, the folder (shelf) names under DropRevive, and whether the list finished. */
export type DriveListing = { remote: RemoteMeta[]; names: string[]; complete: boolean };

/** Folder operations on one drive (create-or-find, move a file, remove an empty folder). */
export type ShelfOps = {
  folder: (token: string, shelf?: string) => Promise<string>;
  move: (token: string, fileId: string, folderId: string) => Promise<void>;
  remove: (token: string, shelf: string) => Promise<boolean>;
};

export async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/**
 * Where a remote meta sits decides its shelf when the cloud changed since the last sync
 * (another device moved it); otherwise a local folder that differs is a pending move.
 */
export function placeRef(item: DropRecord, ref: CloudRef, shelf: string | undefined, base: CloudRef | undefined): DropRecord {
  // No earlier copy on this drive: where the file sits is where it belongs.
  const moved = base ? (base.shelf ?? "") !== (shelf ?? "") : true;
  return {
    ...item,
    refs: [...item.refs.filter((entry) => entry.provider !== ref.provider), { ...ref, ...(shelf ? { shelf } : { shelf: undefined }) }],
    ...(moved ? { folders: setFolder(item.folders, ref.provider, shelf) } : {}),
  };
}

/** Folders with this drive's entry set (or cleared); the other drive's entry is kept. */
export function setFolder(folders: DropRecord["folders"], provider: ProviderId, shelf: string | undefined): NonNullable<DropRecord["folders"]> {
  const next = { ...folders };
  if (shelf) next[provider] = shelf;
  else delete next[provider];
  return next;
}

/** The same folder on every drive the refs are on. */
export function foldersFor(refs: CloudRef[], shelf: string | undefined): NonNullable<DropRecord["folders"]> {
  return refs.reduce((folders, ref) => setFolder(folders, ref.provider, shelf), {} as NonNullable<DropRecord["folders"]>);
}

export function folderKey(item: DropRecord): string {
  return `${item.folders?.google ?? ""}\u0000${item.folders?.microsoft ?? ""}`;
}

/** Drop one drive's ref. With `metaId`, only that file; otherwise every ref on the drive. */
export function dropProviderRef(item: DropRecord, provider: ProviderId, metaId?: string): DropRecord {
  const refs = item.refs.filter(
    (ref) => ref.provider !== provider || (metaId !== undefined && ref.metaId !== metaId),
  );
  const revs = { ...item.revs };
  if (!refs.some((ref) => ref.provider === provider)) delete revs[provider];
  return { ...item, refs, revs };
}

/** A meta that landed on `ownerId` must not also stay attached to an older local row. */
function claimMeta(byId: Map<string, DropRecord>, provider: ProviderId, metaId: string, ownerId: string): void {
  for (const [id, item] of byId) {
    if (id === ownerId) continue;
    if (!item.refs.some((ref) => ref.provider === provider && ref.metaId === metaId)) continue;
    byId.set(id, dropProviderRef(item, provider, metaId));
  }
}

async function mergeRemote(
  provider: ProviderId,
  token: string,
  remote: RemoteMeta[],
  byId: Map<string, DropRecord>,
  original: DropRecord[],
  read: (token: string, id: string) => Promise<string>,
): Promise<{ failed: number; failedIds: Set<string> }> {
  const pending = [];
  const failedIds = new Set<string>();
  for (const file of remote) {
    const known = original.find((item) =>
      item.refs.some((ref) => ref.provider === provider && ref.metaId === file.id),
    );
    if (known && known.revs[provider] === file.modifiedTime) {
      const current = byId.get(known.id);
      const ref = known.refs.find((entry) => entry.provider === provider && entry.metaId === file.id);
      if (current && ref) {
        byId.set(known.id, {
          ...placeRef(current, ref, file.shelf, ref),
          revs: { ...current.revs, [provider]: file.modifiedTime },
        });
        claimMeta(byId, provider, file.id, known.id);
      }
      continue;
    }
    pending.push(file);
  }

  let failed = 0;
  await mapPool(pending, 4, async (file) => {
    try {
      const meta = parseMeta(await read(token, file.id));
      if (!meta) {
        failed += 1;
        failedIds.add(file.id);
        return;
      }
      const fresh = recordFromMeta(meta, provider, file.id, file.modifiedTime);
      const existing = byId.get(meta.id);
      const ref = fresh.refs[0];
      if (!ref) {
        failed += 1;
        failedIds.add(file.id);
        return;
      }
      const base = original.find((item) => item.id === meta.id)?.refs.find((entry) => entry.provider === provider);
      if (!existing) {
        byId.set(meta.id, placeRef(fresh, ref, file.shelf, base));
      } else {
        byId.set(meta.id, {
          ...placeRef(existing, ref, file.shelf, base),
          kind: fresh.kind,
          createdAt: fresh.createdAt,
          deviceId: fresh.deviceId,
          deviceName: fresh.deviceName,
          text: fresh.text,
          fileName: fresh.fileName,
          mimeType: fresh.mimeType,
          size: fresh.size,
          revs: { ...existing.revs, [provider]: file.modifiedTime },
        });
      }
      claimMeta(byId, provider, file.id, meta.id);
    } catch {
      failed += 1;
      failedIds.add(file.id);
    }
  });
  return { failed, failedIds };
}

/**
 * List, merge, then make the cloud match local intent: create pending shelves, move
 * items whose shelf changed here, and empty + remove shelves deleted here.
 */
export type ProviderSync = {
  items: DropRecord[];
  readFailed: number;
  shelfFailed: number;
  incomplete: boolean;
  shelves: Shelf[];
};

export async function reconcileProvider(
  provider: ProviderId,
  token: string,
  listing: DriveListing,
  items: DropRecord[],
  shelves: Shelf[],
  read: (token: string, id: string) => Promise<string>,
  ops: ShelfOps,
): Promise<ProviderSync> {
  const byId = new Map<string, DropRecord>();
  for (const item of items) {
    byId.set(item.id, { ...item, refs: [...item.refs], revs: { ...item.revs } });
  }
  const { remote, names, complete } = listing;
  const merged = await mergeRemote(provider, token, remote, byId, items, read);
  const listedIds = new Set(remote.map((file) => file.id));
  // A missing meta is a delete only when the listing finished and that file was not merely unreadable.
  if (complete) {
    for (const [id, item] of byId) {
      const ref = item.refs.find((entry) => entry.provider === provider);
      if (!ref || listedIds.has(ref.metaId) || merged.failedIds.has(ref.metaId)) continue;
      byId.set(id, dropProviderRef(item, provider));
    }
  }

  const mine = shelves.filter((shelf) => shelf.provider === provider);
  const removed = new Set(mine.filter((shelf) => shelf.state === "removed").map((shelf) => shelf.id));
  const known = new Set(names);
  const pendingLeft: Shelf[] = [];
  let shelfFailed = 0;
  for (const shelf of mine) {
    if (shelf.state !== "pending" || known.has(shelf.id)) continue;
    try {
      await ops.folder(token, shelf.id);
      known.add(shelf.id);
    } catch {
      shelfFailed += 1;
      pendingLeft.push(shelf);
    }
  }
  for (const [id, item] of byId) {
    const ref = item.refs.find((entry) => entry.provider === provider);
    // Items with no copy on this drive are none of this drive's business (its removed folders included).
    if (!ref) continue;
    const intent = item.folders?.[provider];
    const want = intent && !removed.has(intent) ? intent : undefined;
    if ((ref.shelf ?? "") === (want ?? "")) {
      if (want !== intent) byId.set(id, { ...item, folders: setFolder(item.folders, provider, want) });
      continue;
    }
    try {
      const folderId = await ops.folder(token, want);
      await ops.move(token, ref.metaId, folderId);
      if (ref.blobId) await ops.move(token, ref.blobId, folderId);
      byId.set(id, {
        ...item,
        folders: setFolder(item.folders, provider, want),
        refs: item.refs.map((entry) => (entry === ref ? { ...entry, shelf: want } : entry)),
      });
      if (want) known.add(want);
    } catch {
      shelfFailed += 1;
    }
  }
  for (const name of removed) {
    try {
      const gone = await ops.remove(token, name);
      if (gone) known.delete(name);
      else {
        // Still on the drive (files left inside). Show it again and say so.
        removed.delete(name);
        shelfFailed += 1;
      }
    } catch {
      shelfFailed += 1;
    }
  }
  const nextShelves: Shelf[] = [];
  for (const name of known) {
    nextShelves.push(
      removed.has(name) ? { id: name, name, provider, state: "removed" } : { id: name, name, provider },
    );
  }
  for (const shelf of pendingLeft) {
    if (!known.has(shelf.id)) nextShelves.push(shelf);
  }
  return {
    items: [...byId.values()].filter((item) => item.refs.length > 0),
    readFailed: merged.failed,
    shelfFailed,
    incomplete: !complete,
    shelves: nextShelves,
  };
}

/**
 * A drive was disconnected on this device: forget its folder list here (every state,
 * pending and removed included) and each item's folder on it. The refs stay, since the
 * files are still on the drive, but they forget their folder too. On reconnect the
 * listing's folder then reads as news (placeRef sees a change) and sets `folders` from
 * the cloud, instead of a missing local folder reading as a move to the drive's root.
 * Nothing on the drive is touched. Unchanged items keep their identity.
 */
export function forgetDrive(
  provider: ProviderId,
  items: DropRecord[],
  shelves: Shelf[],
): { items: DropRecord[]; shelves: Shelf[] } {
  let changed = false;
  const nextItems = items.map((item) => {
    const hasFolder = item.folders?.[provider] !== undefined;
    const hasShelf = item.refs.some((ref) => ref.provider === provider && ref.shelf !== undefined);
    if (!hasFolder && !hasShelf) return item;
    changed = true;
    return {
      ...item,
      folders: setFolder(item.folders, provider, undefined),
      refs: item.refs.map((ref) => {
        if (ref.provider !== provider || ref.shelf === undefined) return ref;
        const { shelf: _shelf, ...rest } = ref;
        return rest;
      }),
    };
  });
  return {
    items: changed ? nextItems : items,
    shelves: shelves.filter((shelf) => shelf.provider !== provider),
  };
}

/**
 * The sidebar selection once the folder list changed. A folder that is no longer listed
 * for its drive (disconnected, or gone from the cloud) falls back to that drive's root
 * while the drive is connected, otherwise to 全部. Anything else is kept as is.
 */
export function scopeAfterShelves(scope: Scope, shelves: Shelf[], connected: boolean): Scope {
  if (scope.provider === "all" || !scope.shelfId) return scope;
  const { provider, shelfId } = scope;
  if (shelves.some((shelf) => shelf.provider === provider && shelf.id === shelfId)) return scope;
  return connected ? { provider, shelfId: null } : { provider: "all", shelfId: null };
}
