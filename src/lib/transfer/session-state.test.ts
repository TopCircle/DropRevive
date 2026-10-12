import assert from "node:assert/strict";
import test from "node:test";
import { capTimeline, crossedUnsavedLimit, lanBadge, pendingOffers, unsavedSummary, visibleNudge } from "./session-state.ts";
import type { TimelineEntry } from "./timeline.ts";

function notice(n: number): TimelineEntry {
  return { kind: "notice", id: `n${n}`, at: n, tone: "info", text: `n${n}` };
}

function batch(id: string, status: "done" | "confirm" | "transfer", fileIds: string[] = []): TimelineEntry {
  return {
    kind: "batch",
    id,
    at: 0,
    direction: "in",
    sender: "peer",
    status,
    text: "",
    textBytes: 0,
    files: fileIds.map((fid) => ({ id: fid, name: fid, size: 1 })),
    total: 1,
    done: 0,
  } as TimelineEntry;
}

test("capTimeline drops the oldest settled entries but keeps open batches and unsaved files", () => {
  const entries = [batch("open", "transfer"), batch("held", "done", ["f1"]), notice(1), batch("old", "done"), notice(2), notice(3)];
  const capped = capTimeline(entries, 3, (id) => id === "f1");
  assert.deepEqual(
    capped.map((entry) => entry.id),
    ["open", "held", "n3"],
  );
  assert.equal(capTimeline(entries, 10, () => false), entries);
});

test("unsavedSummary counts only files not saved yet", () => {
  const saves = [
    { id: "a", bytes: new Uint8Array(10) },
    { id: "b", bytes: new Uint8Array(5) },
  ];
  assert.deepEqual(unsavedSummary(saves, new Set(["a"])), { count: 1, bytes: 5 });
});

test("crossedUnsavedLimit fires only on the crossing", () => {
  assert.equal(crossedUnsavedLimit(90, 110, 100), true);
  assert.equal(crossedUnsavedLimit(110, 120, 100), false);
  assert.equal(crossedUnsavedLimit(10, 20, 100), false);
});

test("lanBadge: dot while linked, count of waiting offers and unsaved files", () => {
  assert.deepEqual(lanBadge({ phase: "idle", unsaved: 0, pendingOffers: 0 }), { live: false, count: 0 });
  assert.deepEqual(lanBadge({ phase: "connected", unsaved: 2, pendingOffers: 1 }), { live: true, count: 3 });
  assert.deepEqual(lanBadge({ phase: "failed", unsaved: 1, pendingOffers: 0 }), { live: false, count: 1 });
  assert.equal(pendingOffers([batch("x", "confirm"), batch("y", "done")]), 1);
});

test("visibleNudge reports what dropped while the tab was hidden", () => {
  const healthy = { opened: true, finished: false, socket: "open" as const, channel: "open", peer: "connected" };
  assert.equal(visibleNudge(healthy), null);
  assert.equal(visibleNudge({ ...healthy, opened: false, socket: "closed" }), null);
  assert.equal(visibleNudge({ ...healthy, finished: true, peer: "failed" }), null);
  assert.equal(visibleNudge({ ...healthy, peer: "failed" }), "pc-failed");
  assert.equal(visibleNudge({ ...healthy, peer: "disconnected" }), "pc-disconnected");
  assert.equal(visibleNudge({ ...healthy, channel: "closed" }), "dc-close");
  assert.equal(visibleNudge({ ...healthy, socket: "closed" }), "ws-close");
  assert.equal(visibleNudge({ ...healthy, socket: "connecting" }), null);
});
