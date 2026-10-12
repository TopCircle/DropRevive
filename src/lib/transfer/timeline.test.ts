import assert from "node:assert/strict";
import test from "node:test";
import { linkVisual, offerBlocked, openBatchFails, reduceTimeline, sessionVisible, stickToEnd, type TimelineEntry } from "./timeline.ts";

const file = { id: "f1", name: "a.txt", size: 4 };

function batches(entries: TimelineEntry[]) {
  return entries.filter((entry) => entry.kind === "batch");
}

test("an offer becomes its own waiting entry and a later offer stays beside it", () => {
  let entries = reduceTimeline([], {
    type: "offer",
    id: "A",
    at: 1,
    sender: "phone",
    text: "hello",
    files: [file],
    total: 9,
  });
  entries = reduceTimeline(entries, { type: "status", id: "A", status: "transfer" });
  entries = reduceTimeline(entries, { type: "progress", id: "A", done: 4, total: 9 });
  entries = reduceTimeline(entries, { type: "status", id: "A", status: "done" });
  entries = reduceTimeline(entries, {
    type: "offer",
    id: "B",
    at: 2,
    sender: "phone",
    text: "",
    files: [],
    total: 0,
  });
  const items = batches(entries);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.status, "done");
  assert.equal(items[0]?.done, 4);
  assert.equal(items[1]?.id, "B");
  assert.equal(items[1]?.status, "waiting");
  assert.equal(linkVisual("connected", null), "live");
  assert.equal(sessionVisible("connected"), true);
});

test("the receiver accepts or declines on the same incoming entry", () => {
  let entries = reduceTimeline([], {
    type: "incoming",
    id: "IN",
    at: 1,
    sender: "laptop",
    textBytes: 3,
    files: [file],
    total: 7,
  });
  assert.equal(batches(entries)[0]?.status, "confirm");
  entries = reduceTimeline(entries, { type: "status", id: "IN", status: "transfer" });
  entries = reduceTimeline(entries, { type: "progress", id: "IN", done: 7, total: 7 });
  entries = reduceTimeline(entries, { type: "text", id: "IN", text: "hi" });
  entries = reduceTimeline(entries, { type: "status", id: "IN", status: "done" });
  const done = batches(entries)[0];
  assert.equal(done?.text, "hi");
  assert.equal(done?.status, "done");
  assert.equal(done?.done, 7);

  const declined = reduceTimeline(
    reduceTimeline([], { type: "incoming", id: "IN", at: 1, sender: "laptop", textBytes: 0, files: [], total: 0 }),
    { type: "status", id: "IN", status: "declined" },
  );
  assert.equal(batches(declined)[0]?.status, "declined");
  assert.equal(linkVisual("connected", null), "live");
});

test("progress and failure stay on the open batch", () => {
  let entries = reduceTimeline([], {
    type: "offer",
    id: "OLD",
    at: 1,
    sender: "phone",
    text: "kept",
    files: [],
    total: 4,
  });
  entries = reduceTimeline(entries, { type: "status", id: "OLD", status: "done" });
  entries = reduceTimeline(entries, {
    type: "offer",
    id: "NOW",
    at: 2,
    sender: "phone",
    text: "open",
    files: [],
    total: 8,
  });
  entries = reduceTimeline(entries, { type: "status", id: "NOW", status: "transfer" });
  entries = reduceTimeline(entries, { type: "progress", id: "OLD", done: 1, total: 1 });
  entries = reduceTimeline(entries, { type: "progress", id: "NOW", done: 3, total: 8 });
  entries = reduceTimeline(entries, { type: "fail-open" });
  const items = batches(entries);
  assert.equal(items[0]?.status, "done");
  assert.equal(items[0]?.done, 0);
  assert.equal(items[1]?.status, "failed");
  assert.equal(items[1]?.done, 3);
  assert.equal(openBatchFails("transfer.interrupted", "connected"), true);
  assert.equal(openBatchFails("transfer.reconnecting", "sending"), false);
});

test("connection notices are separate from batch status and do not repeat", () => {
  let entries = reduceTimeline([], { type: "notice", at: 1, tone: "reconnect", text: "正在重连…" });
  entries = reduceTimeline(entries, { type: "notice", at: 2, tone: "reconnect", text: "正在重连…" });
  assert.equal(entries.length, 1);
  entries = reduceTimeline(entries, {
    type: "offer",
    id: "A",
    at: 3,
    sender: "phone",
    text: "",
    files: [],
    total: 0,
  });
  entries = reduceTimeline(entries, { type: "notice", at: 4, tone: "end", text: "对方已断开。" });
  assert.equal(entries.at(-1)?.kind, "notice");
  assert.equal(linkVisual("sending", "transfer.reconnecting"), "reconnecting");
  assert.equal(linkVisual("connected", "transfer.signaling"), "reconnecting");
  assert.equal(offerBlocked("connected", "transfer.signaling"), false);
  assert.equal(offerBlocked("connected", "transfer.reconnecting"), true);
  assert.equal(offerBlocked("connected", null), false);
  assert.equal(offerBlocked("sending", "transfer.signaling"), true);
  assert.equal(offerBlocked("offering", null), true);
  assert.equal(linkVisual("joining", null), "connecting");
  assert.equal(linkVisual("failed", "transfer.peerLeft"), "ended");
  assert.equal(linkVisual("failed", "transfer.failed"), "failed");
  assert.equal(linkVisual("connected", null), "live");
  entries = reduceTimeline(entries, { type: "clear-reconnect" });
  assert.equal(entries.some((entry) => entry.kind === "notice" && entry.tone === "reconnect"), false);
  assert.equal(entries.at(-1)?.kind, "notice");
  assert.equal(sessionVisible("hosting"), false);
  assert.equal(sessionVisible("idle"), false);
  assert.equal(sessionVisible("failed"), true);
});

test("a new session drops the previous disconnect line and keeps what arrived", () => {
  let entries = reduceTimeline([], {
    type: "offer",
    id: "A",
    at: 1,
    sender: "phone",
    text: "hello",
    files: [],
    total: 5,
  });
  entries = reduceTimeline(entries, { type: "notice", at: 2, tone: "end", text: "已断开。" });
  entries = reduceTimeline(entries, { type: "clear-end" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "batch");
});

test("the timeline follows new entries only while the reader is near the end", () => {
  assert.equal(stickToEnd(120, 200, 80), true);
  assert.equal(stickToEnd(0, 500, 100), false);
});

test("clear-stale drops fail and end notices but keeps batches and other notices", () => {
  let entries: TimelineEntry[] = [];
  entries = reduceTimeline(entries, { type: "offer", id: "a", at: 1, sender: "me", text: "", files: [], total: 0 });
  entries = reduceTimeline(entries, { type: "status", id: "a", status: "done" });
  entries = reduceTimeline(entries, { type: "notice", at: 2, tone: "fail", text: "failed" });
  entries = reduceTimeline(entries, { type: "notice", at: 3, tone: "end", text: "peer left" });
  entries = reduceTimeline(entries, { type: "notice", at: 4, tone: "info", text: "declined" });
  entries = reduceTimeline(entries, { type: "clear-stale" });
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "batch" ? `batch:${entry.status}` : `notice:${entry.tone}`)),
    ["batch:done", "notice:info"],
  );
});
