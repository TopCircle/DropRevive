import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LONG_PRESS_MS, LongPress } from "./use-long-press.ts";

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

describe("long press (phone bubbles)", () => {
  it("fires once after 500 ms held still", () => {
    const c = clock();
    let fired = 0;
    const press = new LongPress(() => (fired += 1), c.timers);
    press.down(100, 100);
    c.advance(LONG_PRESS_MS - 1);
    assert.equal(fired, 0);
    c.advance(1);
    assert.equal(fired, 1);
    assert.equal(press.fired, true);
    press.cancel(); // finger lifts
    c.advance(1000);
    assert.equal(fired, 1);
  });

  it("a finger that moves (scrolling) or lifts early never fires", () => {
    const c = clock();
    let fired = 0;
    const press = new LongPress(() => (fired += 1), c.timers);
    press.down(100, 100);
    press.move(104, 106); // jitter inside the slop
    press.move(100, 130); // scrolling
    c.advance(1000);
    assert.equal(fired, 0);
    assert.equal(press.fired, false);
    press.down(100, 100);
    c.advance(200);
    press.cancel();
    c.advance(1000);
    assert.equal(fired, 0);
  });
});
