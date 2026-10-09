import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HIDE_AFTER_MS, MIN_THUMB_PX, ThumbVisibility, TRACK_INSET_PX, dragScrollTop, thumbGeometry } from "./overlay-scrollbar-core.ts";

function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        timers.set(next, { at: now + ms, run });
        return next++;
      },
      clear: (handle: unknown) => void timers.delete(handle as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

describe("desktop overlay scrollbar: geometry", () => {
  it("the track is the full pane height; the thumb runs from the top inset to the bottom inset", () => {
    const top = thumbGeometry({ scrollTop: 0, scrollHeight: 3200, clientHeight: 800 });
    assert.equal(top.scrollable, true);
    assert.equal(top.offset, TRACK_INSET_PX);
    assert.equal(top.size, (796 * 800) / 3200);
    const bottom = thumbGeometry({ scrollTop: 2400, scrollHeight: 3200, clientHeight: 800 });
    assert.equal(bottom.offset + bottom.size, 800 - TRACK_INSET_PX);
  });

  it("very long content keeps a grabbable thumb; content that fits has none", () => {
    assert.equal(thumbGeometry({ scrollTop: 0, scrollHeight: 100_000, clientHeight: 800 }).size, MIN_THUMB_PX);
    assert.equal(thumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 }).scrollable, false);
  });

  it("dragging the thumb maps its free travel onto the scroll range, clamped", () => {
    const metrics = { scrollTop: 0, scrollHeight: 3200, clientHeight: 800 };
    const free = 796 - thumbGeometry(metrics).size;
    assert.equal(dragScrollTop(0, free / 2, metrics), 1200);
    assert.equal(dragScrollTop(0, free * 3, metrics), 2400);
    assert.equal(dragScrollTop(1200, -free * 3, metrics), 0);
  });
});

describe("desktop overlay scrollbar: when the thumb shows", () => {
  it("shows while scrolling and hides a second after the last scroll", () => {
    const c = clock();
    const changes: boolean[] = [];
    const v = new ThumbVisibility((on) => changes.push(on), c.timers);
    v.scrolled();
    c.advance(600);
    v.scrolled();
    c.advance(HIDE_AFTER_MS - 1);
    assert.equal(v.visible, true);
    c.advance(1);
    assert.equal(v.visible, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("stays while hovering near the edge or dragging, then hides a second after", () => {
    const c = clock();
    const v = new ThumbVisibility(() => {}, c.timers);
    v.hover(true);
    c.advance(5000);
    assert.equal(v.visible, true);
    v.drag(true);
    v.hover(false);
    c.advance(5000);
    assert.equal(v.visible, true, "dragging keeps it even with the pointer off the edge");
    v.drag(false);
    c.advance(HIDE_AFTER_MS);
    assert.equal(v.visible, false);
  });
});
