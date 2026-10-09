import { filterItems } from "./meta.ts";
import type { DropRecord, Scope } from "./types.ts";

/** The drive / folder / 全部 view: what the sidebar selection shows (desktop stream, phone list). */
export function inScope(item: DropRecord, scope: Scope): boolean {
  if (scope.provider === "all") return true;
  const onDrive = item.refs.some((ref) => ref.provider === scope.provider);
  // Folders are per drive: a same-named folder on the other drive is a different folder.
  return scope.shelfId ? onDrive && item.folders?.[scope.provider] === scope.shelfId : onDrive;
}

/** Identifies the current desktop view; a search belongs to the view it was typed in. */
export function viewKey(scope: Scope): string {
  return `${scope.provider}/${scope.shelfId ?? ""}`;
}

export type DesktopSearch = { open: boolean; query: string; view: string };

/** The search as the current view sees it: switching drive / folder / 全部 starts from an empty query. */
export function searchInView(search: DesktopSearch, view: string): DesktopSearch {
  return search.view === view ? search : { ...search, query: "", view };
}

/**
 * Desktop search: only the current view's items, matched by the same matcher as the phone
 * search (filterItems' text match), with no other filters.
 */
export function viewResults(items: readonly DropRecord[], scope: Scope, query: string): DropRecord[] {
  return filterItems(
    items.filter((item) => inScope(item, scope)),
    { text: query, kind: "all", provider: "all", date: "all" },
  );
}
