import { foldersFor } from "./reconcile";
import { readJson, writeJson } from "./secrets";
import type { StoreSet } from "./store-core";
import { SHELVES_KEY, type DropRecord, type Shelf } from "./types";

export /** Folder names become subfolder names on both drives, so keep them legal there. */
function shelfName(name: string): string {
  return name.replace(/[\\/:*?"<>|#%]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export /** Last entry per provider+name wins, so a later "removed"/"pending" beats a synced copy. */
function saveShelves(set: StoreSet, list: Shelf[]): void {
  const shelves = [...new Map(list.map((shelf) => [`${shelf.provider}:${shelf.id}`, shelf])).values()];
  writeJson(SHELVES_KEY, shelves);
  set({ shelves });
}

export /**
 * Shelves used to be local-only with random ids; those become pending cloud folders
 * named after the shelf, and `renamed` maps old ids so items keep their folder.
 */
function loadShelves(): { shelves: Shelf[]; renamed: Map<string, string> } {
  const raw = readJson<unknown>(SHELVES_KEY, []);
  const renamed = new Map<string, string>();
  if (!Array.isArray(raw)) return { shelves: [], renamed };
  const shelves = raw.flatMap((item): Shelf[] => {
    const shelf = item as Partial<Shelf> | null;
    if (!shelf || typeof shelf.id !== "string" || typeof shelf.name !== "string") return [];
    if (shelf.provider !== "google" && shelf.provider !== "microsoft") return [];
    const name = shelfName(shelf.name);
    if (!name) return [];
    if (shelf.id === name) return [{ id: name, name, provider: shelf.provider, ...(shelf.state ? { state: shelf.state } : {}) }];
    renamed.set(shelf.id, name);
    return [{ id: name, name, provider: shelf.provider, state: "pending" }];
  });
  return { shelves, renamed };
}

export /** Records saved before folders were per drive carry one shelfId for all their drives. */
function migrateFolders(item: DropRecord, renamed: Map<string, string>): DropRecord {
  const copy: DropRecord & { shelfId?: string } = { ...item };
  const legacy = copy.shelfId;
  delete copy.shelfId;
  const folders = legacy ? foldersFor(copy.refs, legacy) : { ...copy.folders };
  for (const provider of ["google", "microsoft"] as const) {
    const name = folders[provider];
    if (name && renamed.has(name)) folders[provider] = renamed.get(name);
  }
  return { ...copy, folders };
}
