/**
 * DOM-free core of the desktop overlay scrollbar: thumb geometry over a full-height track,
 * drag-to-scroll mapping, and when the thumb shows (scrolling, hover near the edge, dragging)
 * and hides (HIDE_AFTER_MS after the last of those).
 */

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export const MIN_THUMB_PX = 32;
/** Gap between the thumb and the very top / bottom of the track. */
export const TRACK_INSET_PX = 2;
export const HIDE_AFTER_MS = 1000;
/** The pointer within this many px of the pane's right edge shows the thumb. */
export const EDGE_PX = 24;

export type ThumbGeometry = { scrollable: boolean; size: number; offset: number };

export function thumbGeometry(metrics: ScrollMetrics): ThumbGeometry {
  const range = metrics.scrollHeight - metrics.clientHeight;
  const track = metrics.clientHeight - TRACK_INSET_PX * 2;
  if (range <= 1 || track <= 0) return { scrollable: false, size: 0, offset: TRACK_INSET_PX };
  const size = Math.min(track, Math.max(MIN_THUMB_PX, (track * metrics.clientHeight) / metrics.scrollHeight));
  const ratio = Math.min(1, Math.max(0, metrics.scrollTop / range));
  return { scrollable: true, size, offset: TRACK_INSET_PX + ratio * (track - size) };
}

/** scrollTop after dragging the thumb `dy` px from where it was grabbed (at `startTop`). */
export function dragScrollTop(startTop: number, dy: number, metrics: ScrollMetrics): number {
  const range = metrics.scrollHeight - metrics.clientHeight;
  const geometry = thumbGeometry(metrics);
  const free = metrics.clientHeight - TRACK_INSET_PX * 2 - geometry.size;
  if (!geometry.scrollable || free <= 0) return startTop;
  return Math.min(range, Math.max(0, startTop + (dy * range) / free));
}

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

export class ThumbVisibility {
  #onChange: (visible: boolean) => void;
  #timers: Timers;
  #timer: unknown = null;
  #visible = false;
  #hover = false;
  #drag = false;

  constructor(onChange: (visible: boolean) => void, timers: Timers) {
    this.#onChange = onChange;
    this.#timers = timers;
  }

  get visible(): boolean {
    return this.#visible;
  }

  scrolled(): void {
    this.#show();
    this.#hideLater();
  }

  hover(on: boolean): void {
    if (on === this.#hover) return;
    this.#hover = on;
    if (on) this.#show();
    else this.#hideLater();
  }

  drag(on: boolean): void {
    this.#drag = on;
    if (on) this.#show();
    else this.#hideLater();
  }

  dispose(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
  }

  #show(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
    if (this.#visible) return;
    this.#visible = true;
    this.#onChange(true);
  }

  #hideLater(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      if (this.#hover || this.#drag || !this.#visible) return;
      this.#visible = false;
      this.#onChange(false);
    }, HIDE_AFTER_MS);
  }
}
