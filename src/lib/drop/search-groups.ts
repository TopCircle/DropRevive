import type { DropRecord, ProviderId, Shelf } from "./types.ts";

/** One folder on one drive; `folder` null = the drive's main DropRevive folder. */
export type SearchFolder = { key: string; folder: string | null; name: string | null; items: DropRecord[] };
/** `drive` "local" = not on any drive yet (still uploading), shown only when nothing limits to a drive. */
export type SearchSection = { key: string; drive: ProviderId | "local"; count: number; folders: SearchFolder[] };

export const DRIVE_ORDER: readonly ProviderId[] = ["google", "microsoft"];

/**
 * Phone search results grouped the way the drives hold them: drive (sidebar order) > folder
 * (main folder first, then the sidebar's folder order, then any folder the sidebar doesn't
 * list yet, by name) > items in the order given (pass them already time-sorted). An item on
 * both drives shows under each, in that drive's folder. Empty groups are left out.
 */
export function groupByDrive(
  items: readonly DropRecord[],
  options: { shelves: readonly Shelf[]; drives: readonly ProviderId[]; includeLocal?: boolean },
): SearchSection[] {
  const sections: SearchSection[] = [];
  for (const drive of DRIVE_ORDER) {
    if (!options.drives.includes(drive)) continue;
    const listed = options.shelves.filter((shelf) => shelf.provider === drive && shelf.state !== "removed");
    const byFolder = new Map<string, DropRecord[]>();
    for (const item of items) {
      if (!item.refs.some((ref) => ref.provider === drive)) continue;
      // Same rule as the sidebar's folder view (inScope): the folder this drive keeps it in.
      const folder = item.folders?.[drive] ?? "";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), item]);
    }
    if (!byFolder.size) continue;
    const rank = new Map(listed.map((shelf, index) => [shelf.id, index]));
    const order = [...byFolder.keys()].sort((a, b) => {
      if (a === "" || b === "") return a === "" ? -1 : 1;
      const ra = rank.get(a) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b) ?? Number.POSITIVE_INFINITY;
      return ra !== rb ? ra - rb : a.localeCompare(b);
    });
    const folders = order.map((folder) => ({
      key: `${drive}:${folder}`,
      folder: folder || null,
      name: folder ? (listed.find((shelf) => shelf.id === folder)?.name ?? folder) : null,
      items: byFolder.get(folder) ?? [],
    }));
    sections.push({ key: drive, drive, count: folders.reduce((sum, group) => sum + group.items.length, 0), folders });
  }
  if (options.includeLocal) {
    const local = items.filter((item) => !item.refs.length);
    if (local.length) sections.push({ key: "local", drive: "local", count: local.length, folders: [{ key: "local:", folder: null, name: null, items: local }] });
  }
  return sections;
}

/** Each item once, in display order: what 全选 selects and what the count is out of. */
export function uniqueItemIds(sections: readonly SearchSection[]): string[] {
  return [...new Set(sections.flatMap((section) => section.folders.flatMap((group) => group.items.map((item) => item.id))))];
}

/** React key for one appearance of an item (it can appear under both drives). */
export function appearanceKey(group: SearchFolder, item: DropRecord): string {
  return `${group.key}:${item.id}`;
}
