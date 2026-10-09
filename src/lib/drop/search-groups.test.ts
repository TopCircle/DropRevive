import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allVisibleSelected, toggleAllVisible } from "./multi-select.ts";
import { appearanceKey, groupByDrive, uniqueItemIds } from "./search-groups.ts";
import type { DropRecord, Shelf } from "./types.ts";

/** `where`: drive → folder (null = main folder). */
function item(id: string, minute: number, where: Partial<Record<"google" | "microsoft", string | null>>): DropRecord {
  const refs = Object.entries(where).map(([provider, shelf]) => ({
    provider: provider as "google" | "microsoft",
    metaId: `${provider}-${id}`,
    metaName: `d_${id}.json`,
    ...(shelf ? { shelf } : {}),
  }));
  const folders = Object.fromEntries(Object.entries(where).filter(([, shelf]) => shelf)) as DropRecord["folders"];
  const createdAt = new Date(Date.UTC(2026, 9, 2, 0, minute)).toISOString();
  return { id, kind: "text", createdAt, deviceId: "d", deviceName: "Phone", text: id, size: 1, refs, revs: {}, folders };
}

// Sidebar order (store order): Google: Zeta, Alpha, Photos (removed). OneDrive: Work.
const shelves: Shelf[] = [
  { id: "Zeta", name: "Zeta", provider: "google" },
  { id: "Work", name: "Work", provider: "microsoft" },
  { id: "Alpha", name: "Alpha", provider: "google" },
  { id: "Photos", name: "Photos", provider: "google", state: "removed" },
];
const both = item("both", 1, { google: "Alpha", microsoft: null });
const gRoot = item("g-root", 2, { google: null });
const gZeta = item("g-zeta", 3, { google: "Zeta" });
const gAlpha = item("g-alpha", 4, { google: "Alpha" });
const mWork = item("m-work", 5, { microsoft: "Work" });
const gNew = item("g-new", 6, { google: "Unlisted" });
const local = item("local", 7, {});
const all = [both, gRoot, gZeta, gAlpha, mWork, gNew, local];
const shape = (sections: ReturnType<typeof groupByDrive>) =>
  sections.map((section) => [section.drive, section.count, section.folders.map((group) => [group.name ?? "主", group.items.map((entry) => entry.id)])]);

describe("phone search: grouped by drive > folder", () => {
  it("a dual-drive item shows under each drive, in that drive's folder", () => {
    const sections = groupByDrive(all, { shelves, drives: ["google", "microsoft"] });
    assert.deepEqual(shape(sections), [
      ["google", 5, [["主", ["g-root"]], ["Zeta", ["g-zeta"]], ["Alpha", ["both", "g-alpha"]], ["Unlisted", ["g-new"]]]],
      ["microsoft", 2, [["主", ["both"]], ["Work", ["m-work"]]]],
    ]);
  });

  it("folders: main first, then sidebar order, then folders the sidebar doesn't list yet; items keep the given time order", () => {
    const sections = groupByDrive([gAlpha, both], { shelves, drives: ["google"] });
    assert.deepEqual(shape(sections), [["google", 2, [["Alpha", ["g-alpha", "both"]]]]]);
  });

  it("empty groups and disconnected / filtered-out drives are hidden", () => {
    assert.deepEqual(shape(groupByDrive([mWork], { shelves, drives: ["google", "microsoft"] })), [["microsoft", 1, [["Work", ["m-work"]]]]]);
    // Only Google connected (or the 来源 filter says Google): no OneDrive section even for a dual-drive item.
    assert.deepEqual(shape(groupByDrive([both, mWork], { shelves, drives: ["google"] })), [["google", 1, [["Alpha", ["both"]]]]]);
    assert.deepEqual(groupByDrive([], { shelves, drives: ["google", "microsoft"] }), []);
    // Not uploaded yet: its own section only when asked for.
    assert.deepEqual(shape(groupByDrive([local], { shelves, drives: ["google"], includeLocal: true })), [["local", 1, [["主", ["local"]]]]]);
    assert.deepEqual(groupByDrive([local], { shelves, drives: ["google"] }), []);
  });

  it("selection is per item: the dual-drive item counts once and 全选 covers unique visible items", () => {
    const sections = groupByDrive(all, { shelves, drives: ["google", "microsoft"] });
    const ids = uniqueItemIds(sections);
    assert.deepEqual(ids, ["g-root", "g-zeta", "both", "g-alpha", "g-new", "m-work"]);
    const picked = toggleAllVisible([], ids);
    assert.equal(picked.length, 6);
    assert.equal(allVisibleSelected(picked, ids), true);
    // Both appearances read the same id, so toggling either one flips both.
    const appearances = sections.flatMap((section) => section.folders.flatMap((group) => group.items.filter((entry) => entry.id === "both")));
    assert.equal(appearances.length, 2);
    const keys = sections.flatMap((section) => section.folders.flatMap((group) => group.items.map((entry) => appearanceKey(group, entry))));
    assert.equal(new Set(keys).size, keys.length, "React keys are unique");
    assert.ok(keys.includes("google:Alpha:both") && keys.includes("microsoft::both"));
  });
});
