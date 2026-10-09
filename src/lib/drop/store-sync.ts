import { t } from "@/lib/i18n";
import { asCloudError } from "./errors";
import {
  googleLayout,
  googleShelfFolder,
  listGoogleMetas,
  moveGoogleFile,
  readGoogleText,
  removeGoogleShelf,
} from "./google";
import {
  ensureMicrosoftShelf,
  listMicrosoftMetas,
  moveMicrosoftFile,
  readMicrosoftText,
  removeMicrosoftShelf,
} from "./microsoft";
import { type DriveListing, folderKey, type ProviderSync, reconcileProvider } from "./reconcile";
import { sortItems, syncEpoch, type StoreGet, type StoreSet } from "./store-core";
import { replayOutbox } from "./store-delete";
import { sessionsReady, tokenFor } from "./store-session";
import { saveShelves } from "./store-shelves";
import { PROVIDER_LABEL, type DropRecord, type ProviderId, type Shelf } from "./types";

let syncRun: Promise<void> | null = null;
let syncAgain = false;
let syncInteractive = false;

/** The store's sync(): one run at a time; a request during a run queues exactly one more pass. */
export function runSync(set: StoreSet, get: StoreGet, interactive: boolean): Promise<void> {
  if (interactive) syncInteractive = true;
  // One sync at a time; a request during a run queues exactly one more pass.
  if (syncRun) {
    syncAgain = true;
    return syncRun;
  }
  // A send or delete owns the drives. It calls sync() again when it finishes,
  // and that pass still sees syncInteractive if this click asked for one.
  if (get().busy) return Promise.resolve();
  syncRun = (async () => {
    do {
      const userSync = syncInteractive;
      syncInteractive = false;
      syncAgain = false;
      await doSync(set, get, userSync);
    } while (syncAgain);
  })().finally(() => (syncRun = null));
  return syncRun;
}

export const SHELF_OPS = {
  google: { folder: googleShelfFolder, move: moveGoogleFile, remove: removeGoogleShelf },
  microsoft: { folder: ensureMicrosoftShelf, move: moveMicrosoftFile, remove: removeMicrosoftShelf },
} satisfies Record<ProviderId, unknown>;

function providerNotes(provider: ProviderId, result: ProviderSync): string[] {
  const label = PROVIDER_LABEL[provider];
  const notes: string[] = [];
  if (result.incomplete) notes.push(t("err.listIncomplete", { label }));
  if (result.readFailed) notes.push(t("err.readFailed", { label }));
  if (result.shelfFailed) notes.push(t("err.shelfFailed", { label }));
  return notes;
}

async function syncProvider(
  provider: ProviderId,
  token: string,
  items: DropRecord[],
  shelves: Shelf[],
): Promise<ProviderSync> {
  let listing: DriveListing;
  if (provider === "google") {
    const layout = await googleLayout(token);
    const listed = await listGoogleMetas(token, layout);
    listing = { remote: listed.metas, names: layout.shelves.map((folder) => folder.name), complete: listed.complete };
  } else {
    const listed = await listMicrosoftMetas(token);
    listing = { remote: listed.metas, names: listed.shelves, complete: listed.complete };
  }
  const read = provider === "google" ? readGoogleText : readMicrosoftText;
  return reconcileProvider(provider, token, listing, items, shelves, read, SHELF_OPS[provider]);
}

async function doSync(set: StoreSet, get: StoreGet, interactive: boolean): Promise<void> {
  if (!get().hydrated) return;
  if (get().busy) {
    if (interactive) syncInteractive = true;
    return;
  }
  await sessionsReady();
  if (get().busy) {
    if (interactive) syncInteractive = true;
    return;
  }
  const my = syncEpoch();
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    set({ online: false, syncing: false });
    return;
  }
  set({ syncing: true, online: true });
  const abandon = () => set({ syncing: false });
  const snapshotIds = new Set(get().items.map((item) => item.id));
  const snapshotShelf = new Map(get().items.map((item) => [item.id, folderKey(item)]));
  const shelfSnapshot = get().shelves;
  const synced: Shelf[] = [];
  const done = new Set<ProviderId>();
  try {
    let googleToken: string | null = null;
    let microsoftToken: string | null = null;
    const problems: string[] = [];
    if (get().google) {
      try {
        googleToken = await tokenFor("google", get);
      } catch (error) {
        problems.push(asCloudError(error, t("err.googleAuth")).message);
      }
      if (get().google && !googleToken && !problems.some((line) => line.includes("Google"))) {
        problems.push(t("err.googleExpired"));
      }
    }
    if (get().microsoft) {
      try {
        microsoftToken = await tokenFor("microsoft", get);
      } catch (error) {
        problems.push(asCloudError(error, t("err.msAuth")).message);
      }
    }
    if (my !== syncEpoch() || get().busy) {
      abandon();
      return;
    }
    if (!googleToken && !microsoftToken) {
      set({
        syncing: false,
        syncError: problems.length ? problems.join(" ") : null,
      });
      return;
    }
    await replayOutbox(get);
    let next = get().items;
    if (googleToken) {
      try {
        const result = await syncProvider("google", googleToken, next, shelfSnapshot);
        next = result.items;
        synced.push(...result.shelves);
        done.add("google");
        problems.push(...providerNotes("google", result));
      } catch (error) {
        problems.push(asCloudError(error, t("err.googleSync")).message);
      }
    }
    if (my !== syncEpoch() || get().busy) {
      abandon();
      return;
    }
    if (microsoftToken) {
      try {
        const result = await syncProvider("microsoft", microsoftToken, next, shelfSnapshot);
        next = result.items;
        synced.push(...result.shelves);
        done.add("microsoft");
        problems.push(...providerNotes("microsoft", result));
      } catch (error) {
        problems.push(asCloudError(error, t("err.msSync")).message);
      }
    }
    if (my !== syncEpoch() || get().busy) {
      abandon();
      return;
    }
    for (const item of get().items) {
      if (!snapshotIds.has(item.id) && !next.some((entry) => entry.id === item.id)) next.push(item);
    }
    // Shelf moves and folder changes made while this sync ran win; the queued re-run pushes them.
    const local = new Map(get().items.map((item) => [item.id, item]));
    next = next.map((item) => {
      const now = local.get(item.id);
      return now && snapshotIds.has(item.id) && folderKey(now) !== snapshotShelf.get(item.id) ? { ...item, folders: now.folders } : item;
    });
    const later = get().shelves.filter((shelf) => !shelfSnapshot.includes(shelf));
    saveShelves(set, [...shelfSnapshot.filter((shelf) => !done.has(shelf.provider)), ...synced, ...later]);
    set({
      items: sortItems(next),
      syncing: false,
      syncError: problems.length ? problems.join(" ") : null,
      lastSyncAt: Date.now(),
    });
  } catch (error) {
    if (my !== syncEpoch()) {
      abandon();
      return;
    }
    set({ syncing: false, syncError: asCloudError(error, t("err.sync")).message });
  }
}
