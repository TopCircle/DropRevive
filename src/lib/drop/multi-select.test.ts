import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allVisibleSelected, deleteOutcome, moveOutcome, moveTargets, planMove, toggleAllVisible } from "./multi-select.ts";
import type { DropRecord, Shelf } from "./types.ts";

function item(id: string, where: Partial<Record<"google" | "microsoft", string | null>>): DropRecord {
  const refs = Object.entries(where).map(([provider, shelf]) => ({
    provider: provider as "google" | "microsoft",
    metaId: `${provider}-${id}`,
    metaName: `d_${id}.json`,
    ...(shelf ? { shelf } : {}),
  }));
  const folders = Object.fromEntries(Object.entries(where).filter(([, shelf]) => shelf)) as DropRecord["folders"];
  return { id, kind: "text", createdAt: "2026-10-02T00:00:00Z", deviceId: "d", deviceName: "Phone", text: id, size: 1, refs, revs: {}, folders };
}

// OneDrive: Work, Old (removed). Google: Work, Photos.
const shelves: Shelf[] = [
  { id: "Work", name: "Work", provider: "microsoft" },
  { id: "Old", name: "Old", provider: "microsoft", state: "removed" },
  { id: "Work", name: "Work", provider: "google" },
  { id: "Photos", name: "Photos", provider: "google" },
];
const msRoot = item("ms-root", { microsoft: null });
const msWork = item("ms-work", { microsoft: "Work" });
const gPhotos = item("g-photos", { google: "Photos" });
const both = item("both", { google: null, microsoft: null });
const notUploaded: DropRecord = { ...item("outbox", {}), refs: [] };

describe("multi-select: 全选 covers the visible items only", () => {
  it("selects every visible item and drops hidden ones from the selection", () => {
    assert.deepEqual(toggleAllVisible(["hidden", "a"], ["a", "b", "c"]).sort(), ["a", "b", "c"]);
  });
  it("turns into 取消全选 once all visible are selected, and that clears just them", () => {
    assert.equal(allVisibleSelected(["a", "b"], ["a", "b"]), true);
    assert.equal(allVisibleSelected(["a"], ["a", "b"]), false);
    assert.equal(allVisibleSelected([], []), false, "nothing visible: 全选, not 取消全选");
    assert.deepEqual(toggleAllVisible(["a", "b"], ["a", "b"]), []);
  });
});

describe("multi-select: batch move follows the per-drive folder rule", () => {
  it("main folder: anything in a folder moves, the rest is already there", () => {
    const plan = planMove([msRoot, msWork, gPhotos, both], shelves, null);
    assert.deepEqual(plan.movable.sort(), ["g-photos", "ms-work"]);
    assert.deepEqual(plan.already.sort(), ["both", "ms-root"]);
    assert.deepEqual(plan.skipped, []);
  });

  it("a folder only on one drive takes only items that live solely on that drive", () => {
    const plan = planMove([msRoot, gPhotos, both], shelves, "Photos");
    assert.deepEqual(plan.movable, [], "g-photos is already in Photos");
    assert.deepEqual(plan.already, ["g-photos"]);
    assert.deepEqual(plan.skipped.sort(), ["both", "ms-root"], "OneDrive copies have no Photos folder to go to");
    assert.deepEqual(plan.missingOn, ["microsoft"]);
  });

  it("an item on both drives moves only when both drives have the folder", () => {
    assert.deepEqual(planMove([both], shelves, "Work").movable, ["both"]);
    const lopsided = shelves.filter((shelf) => !(shelf.id === "Work" && shelf.provider === "google"));
    const plan = planMove([both, msRoot], lopsided, "Work");
    assert.deepEqual(plan.movable, ["ms-root"]);
    assert.deepEqual(plan.skipped, ["both"]);
    assert.deepEqual(plan.missingOn, ["google"]);
  });

  it("removed folders and not-yet-uploaded items are never targets", () => {
    assert.deepEqual(planMove([msRoot], shelves, "Old").skipped, ["ms-root"]);
    assert.deepEqual(planMove([notUploaded], shelves, null).skipped, ["outbox"]);
  });

  it("the picker lists the main folder and folders on the selection's drives, with counts", () => {
    // Each folder fits both: one moves, the other is already there.
    assert.deepEqual(moveTargets([msRoot, msWork], shelves), [{ target: null, movable: 1, fits: 2, total: 2 }, { target: "Work", movable: 1, fits: 2, total: 2 }]);
    // Google's Photos is offered for a mixed selection, but only the Google-only item can go.
    assert.deepEqual(moveTargets([msRoot, item("g-root", { google: null })], shelves), [
      { target: "Photos", movable: 1, fits: 1, total: 2 },
      { target: "Work", movable: 2, fits: 2, total: 2 },
    ]);
    assert.deepEqual(moveTargets([notUploaded], shelves), []);
  });
});

describe("multi-select: batch results", () => {
  it("delete: what is still listed afterwards failed", () => {
    assert.deepEqual(deleteOutcome(["a", "b", "c"], [item("b", { microsoft: null })]), { done: ["a", "c"], failed: ["b"] });
  });
  it("move: done only when every copy sits in the target", () => {
    const half = item("half", { google: "Work", microsoft: null });
    assert.deepEqual(moveOutcome(["ms-work", "half", "gone"], [msWork, half], "Work"), { done: ["ms-work"], failed: ["half", "gone"] });
  });
});
