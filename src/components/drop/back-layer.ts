/**
 * Full-screen layers on the phone (search, the detail sheet) push one history entry when they
 * open, so the phone / browser Back gesture closes the top layer instead of leaving the app.
 * Each entry carries its depth; a layer closes when history moves below its depth, and a layer
 * the app closes itself (back arrow, Esc, an action) pops its own entry so nothing dangles.
 * DOM-free so it can be tested with a fake history; `use-back-layer.ts` wires it to the router.
 */
export const LAYER_KEY = "dropLayer";

export type LayerHistory = {
  readonly location: { href: string; state: unknown };
  push: (path: string, state?: Record<string, unknown>) => void;
  go: (delta: number) => void;
  flush?: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function layerOf(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const depth = (state as Record<string, unknown>)[LAYER_KEY];
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * Several layers can close in one React commit (closing search while multi-select is on
 * top). Browser history moves asynchronously, so each dispose can't just call back():
 * the pops are merged into one go() to the lowest depth asked for, in a microtask.
 */
const popping = new WeakMap<LayerHistory, number>();

function popTo(history: LayerHistory, depth: number): void {
  const queued = popping.get(history);
  if (queued !== undefined) {
    popping.set(history, Math.min(queued, depth));
    return;
  }
  popping.set(history, depth);
  queueMicrotask(() => {
    const target = popping.get(history) ?? depth;
    popping.delete(history);
    const current = layerOf(history.location.state);
    if (target >= current) return;
    history.flush?.();
    history.go(target - current);
  });
}

export type OpenLayer = {
  depth: number;
  /** True while this layer is the top one (Esc should close it, not one underneath). */
  isTop: () => boolean;
  /** Stop listening; if this layer's entry is still in place, pop it. Safe to call twice. */
  dispose: () => void;
};

export function openLayer(history: LayerHistory, onClose: () => void): OpenLayer {
  const below = history.location.state;
  const depth = layerOf(below) + 1;
  const keep = below && typeof below === "object" ? { ...(below as Record<string, unknown>) } : {};
  history.push(history.location.href, { ...keep, [LAYER_KEY]: depth });
  let live = true;
  const unsubscribe = history.subscribe(() => {
    if (!live || layerOf(history.location.state) >= depth) return;
    live = false;
    unsubscribe();
    onClose();
  });
  return {
    depth,
    isTop: () => live && layerOf(history.location.state) === depth,
    dispose: () => {
      if (!live) return;
      live = false;
      unsubscribe();
      // Our entry (or one above it) is still current: drop back to just below us.
      if (layerOf(history.location.state) >= depth) popTo(history, depth - 1);
    },
  };
}
