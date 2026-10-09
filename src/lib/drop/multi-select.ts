/**
 * Phone multi-select rules, DOM- and store-free so they can be tested directly:
 * select-all over the visible items only, and which items a batch move may touch.
 * Folders live per drive, so an item can only move to a folder that exists on every
 * drive holding a copy of it (the same rule as the single-item folder picker).
 */
import type { DropRecord, ProviderId, Shelf } from "./types.ts";

/** 全选 selects every visible item (keeping hidden ones out); 取消全选 when all visible are selected. */
export function allVisibleSelected(selected: readonly string[], visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
}

export function toggleAllVisible(selected: readonly string[], visibleIds: readonly string[]): string[] {
  if (allVisibleSelected(selected, visibleIds)) return selected.filter((id) => !visibleIds.includes(id));
  return [...new Set([...selected.filter((id) => visibleIds.includes(id)), ...visibleIds])];
}

/** Drives that hold a copy of the item. */
export function drivesOf(item: DropRecord): ProviderId[] {
  return [...new Set(item.refs.map((ref) => ref.provider))];
}

function liveFolder(shelves: readonly Shelf[], name: string, drive: ProviderId): boolean {
  return shelves.some((shelf) => shelf.id === name && shelf.provider === drive && shelf.state !== "removed");
}

export type MovePlan = {
  /** null = the drive's main DropRevive folder. */
  target: string | null;
  movable: string[];
  /** Already in the target on every drive. */
  already: string[];
  /** Can't go there: a drive holding it has no folder of that name (or it isn't uploaded yet). */
  skipped: string[];
  /** Drives whose copies kept an item out (for the explanation). */
  missingOn: ProviderId[];
};

export function planMove(items: readonly DropRecord[], shelves: readonly Shelf[], target: string | null): MovePlan {
  const plan: MovePlan = { target, movable: [], already: [], skipped: [], missingOn: [] };
  const missing = new Set<ProviderId>();
  for (const item of items) {
    const drives = drivesOf(item);
    if (!drives.length) {
      plan.skipped.push(item.id);
      continue;
    }
    const lacking = target === null ? [] : drives.filter((drive) => !liveFolder(shelves, target, drive));
    if (lacking.length) {
      plan.skipped.push(item.id);
      lacking.forEach((drive) => missing.add(drive));
      continue;
    }
    const there = drives.every((drive) => (item.folders?.[drive] ?? null) === target);
    (there ? plan.already : plan.movable).push(item.id);
  }
  plan.missingOn = [...missing];
  return plan;
}

/** `fits` = items that end up in the target (moving now or already there); the rest can't go. */
export type MoveTarget = { target: string | null; movable: number; fits: number; total: number };

/**
 * Folders offered for a batch move: the main folder if anything is in a folder, then every
 * live folder on a drive the selection lives on, with how many selected items can go there.
 * Targets nothing could move to are left out.
 */
export function moveTargets(items: readonly DropRecord[], shelves: readonly Shelf[]): MoveTarget[] {
  const drives = new Set(items.flatMap(drivesOf));
  const names = [
    ...new Set(shelves.filter((shelf) => shelf.state !== "removed" && drives.has(shelf.provider)).map((shelf) => shelf.id)),
  ].sort((a, b) => a.localeCompare(b));
  const options: MoveTarget[] = [];
  for (const target of [null, ...names]) {
    const plan = planMove(items, shelves, target);
    if (plan.movable.length) options.push({ target, movable: plan.movable.length, fits: plan.movable.length + plan.already.length, total: items.length });
  }
  return options;
}

export type BatchOutcome = { done: string[]; failed: string[] };

/** After a batch delete: whatever is still in the list was not (fully) deleted. */
export function deleteOutcome(ids: readonly string[], itemsAfter: readonly DropRecord[]): BatchOutcome {
  const left = new Set(itemsAfter.map((item) => item.id));
  return { done: ids.filter((id) => !left.has(id)), failed: ids.filter((id) => left.has(id)) };
}

/** After the sync that carries a batch move: moved = every copy now sits in the target. */
export function moveOutcome(ids: readonly string[], itemsAfter: readonly DropRecord[], target: string | null): BatchOutcome {
  const byId = new Map(itemsAfter.map((item) => [item.id, item]));
  const done: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    const moved = Boolean(item?.refs.length) && item!.refs.every((ref) => (ref.shelf ?? null) === target);
    (moved ? done : failed).push(id);
  }
  return { done, failed };
}
