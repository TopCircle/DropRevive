import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterItems } from "./meta.ts";
import { inScope, searchInView, viewKey, viewResults, type DesktopSearch } from "./desktop-search.ts";
import type { DropRecord, Scope } from "./types.ts";

function item(id: string, text: string, where: Partial<Record<"google" | "microsoft", string | null>>, minute = 0): DropRecord {
  const refs = Object.entries(where).map(([provider, shelf]) => ({
    provider: provider as "google" | "microsoft",
    metaId: `${provider}-${id}`,
    metaName: `d_${id}.json`,
    ...(shelf ? { shelf } : {}),
  }));
  const folders = Object.fromEntries(Object.entries(where).filter(([, shelf]) => shelf)) as DropRecord["folders"];
  const createdAt = new Date(Date.UTC(2026, 9, 2, 0, minute)).toISOString();
  return { id, kind: "text", createdAt, deviceId: "d", deviceName: "Laptop", text, size: 1, refs, revs: {}, folders };
}

const items = [
  item("g-root", "invoice root", { google: null }, 1),
  item("g-work", "invoice work", { google: "Work" }, 2),
  item("g-work-2", "notes work", { google: "Work" }, 3),
  item("m-work", "invoice onedrive work", { microsoft: "Work" }, 4),
  item("both", "invoice both", { google: "Work", microsoft: null }, 5),
];
const ALL: Scope = { provider: "all", shelfId: null };
const GOOGLE: Scope = { provider: "google", shelfId: null };
const GOOGLE_WORK: Scope = { provider: "google", shelfId: "Work" };
const ids = (list: DropRecord[]) => list.map((entry) => entry.id).sort();

describe("desktop search: scope = the current view", () => {
  it("inside a folder it only finds that folder's items (that drive's folder, not a same-named one elsewhere)", () => {
    assert.deepEqual(ids(viewResults(items, GOOGLE_WORK, "invoice")), ["both", "g-work"]);
    assert.deepEqual(ids(viewResults(items, { provider: "microsoft", shelfId: "Work" }, "invoice")), ["m-work"]);
  });

  it("a drive finds everything on that drive; 全部 finds everything", () => {
    assert.deepEqual(ids(viewResults(items, GOOGLE, "invoice")), ["both", "g-root", "g-work"]);
    assert.deepEqual(ids(viewResults(items, ALL, "invoice")), ["both", "g-root", "g-work", "m-work"]);
  });

  it("an empty query is the whole view, and matching is the phone search's matcher", () => {
    assert.deepEqual(ids(viewResults(items, GOOGLE_WORK, "  ")), ids(items.filter((entry) => inScope(entry, GOOGLE_WORK))));
    for (const text of ["INVOICE", "laptop", "notes", "zzz"]) {
      const phone = filterItems(items, { text, kind: "all", provider: "all", date: "all" });
      assert.deepEqual(ids(viewResults(items, ALL, text)), ids(phone), text);
    }
  });

  it("switching drive / folder / 全部 clears the query; coming back doesn't bring it back", () => {
    const typed: DesktopSearch = { open: true, query: "invoice", view: viewKey(GOOGLE_WORK) };
    assert.equal(searchInView(typed, viewKey(GOOGLE_WORK)), typed);
    const elsewhere = searchInView(typed, viewKey(ALL));
    assert.deepEqual(elsewhere, { open: true, query: "", view: viewKey(ALL) });
    assert.notEqual(viewKey(GOOGLE), viewKey(GOOGLE_WORK));
    assert.notEqual(viewKey({ provider: "microsoft", shelfId: "Work" }), viewKey(GOOGLE_WORK));
    // The component commits each switch (layout effect on the view key), so going back starts empty too.
    assert.equal(searchInView(elsewhere, viewKey(GOOGLE_WORK)).query, "");
  });
});
