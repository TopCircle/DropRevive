import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BottomPin, NEAR_BOTTOM_PX, oldestFirst, ownNewestKey } from "./use-stick-to-bottom.ts";
import type { DropRecord } from "../../lib/drop/types.ts";

const at = (id: string, createdAt: string, deviceId = "other"): DropRecord => ({
  id, kind: "text", createdAt, deviceId, deviceName: "", size: 1, refs: [], revs: {},
});

describe("timeline order", () => {
  it("puts the oldest on top and the newest at the bottom, without touching the input", () => {
    const input = [at("c", "2026-10-01T12:00:00Z"), at("a", "2026-10-01T10:00:00Z"), at("b", "2026-10-01T11:00:00Z")];
    assert.deepEqual(oldestFirst(input).map((item) => item.id), ["a", "b", "c"]);
    assert.deepEqual(input.map((item) => item.id), ["c", "a", "b"]);
  });

  it("ownNewestKey changes only when this device's item is the newest", () => {
    const list = [at("a", "2026-10-01T10:00:00Z", "me"), at("b", "2026-10-01T11:00:00Z", "other")];
    assert.equal(ownNewestKey(list, "me"), "");
    assert.equal(ownNewestKey([...list, at("c", "2026-10-01T12:00:00Z", "me")], "me"), "c");
    assert.equal(ownNewestKey([], "me"), "");
    assert.equal(ownNewestKey(list, ""), "");
  });
});

/** A scroll box like the browser's: scrollTop is clamped to [0, scrollHeight - clientHeight]. */
function box(scrollHeight: number, clientHeight = 500) {
  let top = 0;
  const node = {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, node.scrollHeight - node.clientHeight));
    },
  };
  return node;
}

describe("stick to bottom", () => {
  it("opens at the newest item", () => {
    const node = box(2000);
    const pin = new BottomPin(() => node);
    pin.reset();
    assert.equal(node.scrollTop, 1500);
    assert.equal(pin.pinned, true);
  });

  it("follows new items and late-growing content while at the bottom", () => {
    const node = box(2000);
    const pin = new BottomPin(() => node);
    pin.reset();
    node.scrollHeight = 2600; // a sync brought more, or a thumbnail loaded
    pin.onScroll(); // even if a scroll event lands before the resize callback
    pin.grew();
    assert.equal(node.scrollTop, 2100);
  });

  it("does not yank a user who scrolled up to read; going back down re-pins", () => {
    const node = box(2000);
    const pin = new BottomPin(() => node);
    pin.reset();
    node.scrollTop = 700;
    pin.onScroll();
    assert.equal(pin.pinned, false);
    node.scrollHeight = 2600;
    pin.grew();
    assert.equal(node.scrollTop, 700, "left where the user is reading");
    node.scrollTop = 2100 - NEAR_BOTTOM_PX + 1;
    pin.onScroll();
    assert.equal(pin.pinned, true);
    node.scrollHeight = 3000;
    pin.grew();
    assert.equal(node.scrollTop, 2500);
  });

  it("another folder (or this device sending) jumps to the newest even after scrolling up", () => {
    const node = box(2000);
    const pin = new BottomPin(() => node);
    pin.reset();
    node.scrollTop = 100;
    pin.onScroll();
    node.scrollHeight = 1200; // the other folder's list
    pin.reset();
    assert.equal(node.scrollTop, 700);
    assert.equal(pin.pinned, true);
  });

  it("a short list that fits counts as at the bottom", () => {
    const node = box(300);
    const pin = new BottomPin(() => node);
    pin.reset();
    pin.onScroll();
    assert.equal(node.scrollTop, 0);
    assert.equal(pin.pinned, true);
  });
});
