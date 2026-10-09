import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

export const LONG_PRESS_MS = 500;
/** A finger that drifts further than this is scrolling, not pressing. */
export const PRESS_SLOP_PX = 10;

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

/**
 * One press at a time: fires after LONG_PRESS_MS unless the pointer moves past the slop, lifts
 * or is cancelled (the browser took over to scroll). DOM-free so it can be tested with fake timers.
 */
export class LongPress {
  #fire: () => void;
  #timers: Timers;
  #timer: unknown = null;
  #start = { x: 0, y: 0 };
  #fired = false;

  constructor(fire: () => void, timers: Timers) {
    this.#fire = fire;
    this.#timers = timers;
  }

  down(x: number, y: number): void {
    this.cancel();
    this.#fired = false;
    this.#start = { x, y };
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      this.#fired = true;
      this.#fire();
    }, LONG_PRESS_MS);
  }

  move(x: number, y: number): void {
    if (this.#timer === null) return;
    if (Math.hypot(x - this.#start.x, y - this.#start.y) > PRESS_SLOP_PX) this.cancel();
  }

  cancel(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
  }

  get fired(): boolean {
    return this.#fired;
  }
}

/**
 * After a press fires, the page usually shifts (selection bars appear), so the click and
 * context menu that end the touch can land on a different bubble. Swallow them document-wide
 * until just after the finger lifts.
 */
let releaseSwallow: (() => void) | null = null;
function swallowPressEnd(): void {
  releaseSwallow?.();
  const stopClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    release();
  };
  const stopMenu = (event: Event) => event.preventDefault();
  const lifted = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(release, 400);
  };
  const release = () => {
    window.clearTimeout(timer);
    window.removeEventListener("click", stopClick, true);
    window.removeEventListener("contextmenu", stopMenu, true);
    window.removeEventListener("pointerup", lifted, true);
    window.removeEventListener("pointercancel", lifted, true);
    if (releaseSwallow === release) releaseSwallow = null;
  };
  // Safety net for a finger held down a long time with no pointerup reaching us.
  let timer = window.setTimeout(release, 10_000);
  window.addEventListener("click", stopClick, true);
  window.addEventListener("contextmenu", stopMenu, true);
  window.addEventListener("pointerup", lifted, true);
  window.addEventListener("pointercancel", lifted, true);
  releaseSwallow = release;
}

/** Pointer props for an element that long-presses; nothing when `onLongPress` is unset. */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const press = useRef<LongPress | null>(null);
  if (!press.current) {
    press.current = new LongPress(
      () => {
        // The press may have started a native text selection; drop it.
        window.getSelection()?.removeAllRanges();
        swallowPressEnd();
        latest.current?.();
      },
      { set: (run, ms) => window.setTimeout(run, ms), clear: (handle) => window.clearTimeout(handle as number) },
    );
  }
  useEffect(() => () => press.current?.cancel(), []);
  const lp = press.current;
  const enabled = Boolean(onLongPress);
  return {
    onPointerDown: (event: PointerEvent) => {
      if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      lp.down(event.clientX, event.clientY);
    },
    onPointerMove: (event: PointerEvent) => lp.move(event.clientX, event.clientY),
    onPointerUp: () => lp.cancel(),
    onPointerCancel: () => lp.cancel(),
    onPointerLeave: () => lp.cancel(),
    // The OS menu / callout that a long touch brings up.
    onContextMenu: (event: MouseEvent) => {
      if (enabled) event.preventDefault();
    },
  };
}
