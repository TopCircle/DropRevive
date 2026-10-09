import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LAYER_KEY, layerOf, openLayer, type LayerHistory } from "./back-layer.ts";

/** A browser-ish history stack: push/back move an index, back notifies asynchronously like popstate. */
function fakeHistory() {
  const stack: Array<{ href: string; state: Record<string, unknown> }> = [{ href: "/", state: { __TSR_index: 0 } }];
  let index = 0;
  const listeners = new Set<() => void>();
  const pending: Array<() => void> = [];
  type Entry = { href: string; state: Record<string, unknown> };
  const history: Omit<LayerHistory, "location"> & { readonly location: Entry; index: () => number; length: () => number; settle: () => Promise<void> } = {
    get location() {
      return stack[index];
    },
    push(href, state = {}) {
      stack.splice(index + 1);
      stack.push({ href, state: { ...state, __TSR_index: index + 1 } });
      index += 1;
      listeners.forEach((listener) => listener());
    },
    go(delta) {
      pending.push(() => {
        index = Math.max(0, Math.min(stack.length - 1, index + delta));
        listeners.forEach((listener) => listener());
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    index: () => index,
    length: () => stack.length,
    settle: async () => {
      await Promise.resolve(); // let queued pops (microtasks) reach go()
      while (pending.length) pending.shift()!();
    },
  };
  return history;
}

describe("back layers (phone search / detail sheet)", () => {
  it("reads the depth from history state, ignoring junk", async () => {
    assert.equal(layerOf(null), 0);
    assert.equal(layerOf({}), 0);
    assert.equal(layerOf({ [LAYER_KEY]: 2 }), 2);
    assert.equal(layerOf({ [LAYER_KEY]: "2" }), 0);
    assert.equal(layerOf({ [LAYER_KEY]: -1 }), 0);
  });

  it("opening pushes one entry on the same URL; the Back gesture closes it", async () => {
    const history = fakeHistory();
    let closed = 0;
    const layer = openLayer(history, () => (closed += 1));
    assert.equal(history.index(), 1);
    assert.equal(history.location.href, "/");
    assert.equal(layer.isTop(), true);
    history.go(-1); // phone back gesture
    await history.settle();
    assert.equal(closed, 1);
    assert.equal(history.index(), 0);
    layer.dispose(); // React cleanup after the close: must not go back again
    await history.settle();
    assert.equal(history.index(), 0, "no extra back past the app's own entry");
  });

  it("closing from the app (back arrow / Esc) pops its own entry so nothing dangles", async () => {
    const history = fakeHistory();
    let closed = 0;
    const layer = openLayer(history, () => (closed += 1));
    layer.dispose();
    await history.settle();
    assert.equal(history.index(), 0);
    assert.equal(closed, 0, "the app already closed it; no second close");
    layer.dispose();
    await history.settle();
    assert.equal(history.index(), 0, "dispose twice is a no-op");
  });

  it("stacked layers close top first: detail over search, Back twice", async () => {
    const history = fakeHistory();
    const closed: string[] = [];
    const search = openLayer(history, () => closed.push("search"));
    const detail = openLayer(history, () => closed.push("detail"));
    assert.deepEqual([search.depth, detail.depth], [1, 2]);
    assert.equal(search.isTop(), false);
    assert.equal(detail.isTop(), true);
    history.go(-1);
    await history.settle();
    assert.deepEqual(closed, ["detail"]);
    assert.equal(search.isTop(), true);
    detail.dispose();
    await history.settle();
    assert.equal(history.index(), 1, "search is still open on its entry");
    history.go(-1);
    await history.settle();
    assert.deepEqual(closed, ["detail", "search"]);
    assert.equal(history.index(), 0);
  });

  it("closing the detail from the app leaves search open on its own entry", async () => {
    const history = fakeHistory();
    const closed: string[] = [];
    const search = openLayer(history, () => closed.push("search"));
    const detail = openLayer(history, () => closed.push("detail"));
    detail.dispose(); // X on the detail sheet
    await history.settle();
    assert.equal(history.index(), 1);
    assert.deepEqual(closed, []);
    assert.equal(search.isTop(), true);
  });

  it("keeps the router's existing state fields on the pushed entry", async () => {
    const history = fakeHistory();
    history.location.state.other = "kept";
    openLayer(history, () => undefined);
    assert.equal(history.location.state.other, "kept");
    assert.equal(history.location.state[LAYER_KEY], 1);
  });

  it("multi-select over search: Back leaves multi-select first, then search", async () => {
    const history = fakeHistory();
    const closed: string[] = [];
    const search = openLayer(history, () => closed.push("search"));
    const select = openLayer(history, () => closed.push("select"));
    history.go(-1);
    await history.settle();
    assert.deepEqual(closed, ["select"]);
    select.dispose();
    await history.settle();
    assert.equal(history.index(), 1, "still in search");
    assert.equal(search.isTop(), true);
    history.go(-1);
    await history.settle();
    assert.deepEqual(closed, ["select", "search"]);
    assert.equal(history.index(), 0);
  });

  it("closing search while multi-select is on top pops both entries, once", async () => {
    const history = fakeHistory();
    const closed: string[] = [];
    const search = openLayer(history, () => closed.push("search"));
    const select = openLayer(history, () => closed.push("select"));
    // Back arrow in search: both layers close in one commit (React runs both cleanups).
    select.dispose();
    search.dispose();
    await history.settle();
    assert.equal(history.index(), 0, "back at the app's own entry, nothing dangling");
    assert.deepEqual(closed, [], "the app closed them; history does not close them again");
  });
});
