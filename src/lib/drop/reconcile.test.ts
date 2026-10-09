import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forgetDrive, scopeAfterShelves } from "./reconcile.ts";
import type { DropRecord, Shelf } from "./types.ts";

const base = { kind: "text", createdAt: "2026-10-01T10:00:00.000Z", deviceId: "d1", deviceName: "Laptop", size: 1, revs: {} } as const;

describe("forgetDrive", () => {
  const shelves: Shelf[] = [
    { id: "Work", name: "Work", provider: "microsoft" },
    { id: "New", name: "New", provider: "microsoft", state: "pending" },
    { id: "Gone", name: "Gone", provider: "microsoft", state: "removed" },
    { id: "Work", name: "Work", provider: "google" },
  ];

  it("drops that drive's folders in every state and keeps the other drive's", () => {
    const out = forgetDrive("microsoft", [], shelves);
    assert.deepEqual(out.shelves, [{ id: "Work", name: "Work", provider: "google" }]);
    assert.deepEqual(forgetDrive("google", [], shelves).shelves.map((shelf) => shelf.id), ["Work", "New", "Gone"]);
  });

  it("clears the drive's folder on items and refs, keeps the refs and the other drive, and leaves untouched items as they are", () => {
    const both: DropRecord = {
      ...base,
      id: "b",
      refs: [
        { provider: "google", metaId: "g", metaName: "d_b.json", shelf: "Work" },
        { provider: "microsoft", metaId: "m", metaName: "d_b.json", shelf: "Work" },
      ],
      folders: { google: "Work", microsoft: "Work" },
    };
    const googleOnly: DropRecord = { ...base, id: "g", refs: [{ provider: "google", metaId: "g2", metaName: "d_g.json" }], folders: {} };
    const out = forgetDrive("microsoft", [both, googleOnly], shelves);
    assert.deepEqual(out.items[0]!.folders, { google: "Work" });
    assert.deepEqual(out.items[0]!.refs, [
      { provider: "google", metaId: "g", metaName: "d_b.json", shelf: "Work" },
      { provider: "microsoft", metaId: "m", metaName: "d_b.json" },
    ]);
    assert.equal(out.items[1], googleOnly);
    const items = [googleOnly];
    assert.equal(forgetDrive("microsoft", items, shelves).items, items, "nothing to forget keeps the same array");
  });
});

describe("scopeAfterShelves", () => {
  const shelves: Shelf[] = [{ id: "Work", name: "Work", provider: "google" }];

  it("keeps 全部, a drive root and a folder that is still listed", () => {
    const all = { provider: "all", shelfId: null } as const;
    const root = { provider: "microsoft", shelfId: null } as const;
    const work = { provider: "google", shelfId: "Work" } as const;
    assert.equal(scopeAfterShelves(all, [], false), all);
    assert.equal(scopeAfterShelves(root, [], false), root);
    assert.equal(scopeAfterShelves(work, shelves, true), work);
  });

  it("leaves a folder that is gone: to 全部 when its drive is disconnected, else to the drive's root", () => {
    assert.deepEqual(scopeAfterShelves({ provider: "microsoft", shelfId: "Work" }, shelves, false), { provider: "all", shelfId: null });
    assert.deepEqual(scopeAfterShelves({ provider: "microsoft", shelfId: "Work" }, shelves, true), { provider: "microsoft", shelfId: null });
  });
});
