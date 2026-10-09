// Which edges of a scroll box have content hidden past them. Used by the settings dialog for its
// header divider, its footer divider and the fade mask on the scrolling list.

export type ScrollEdges = { above: boolean; below: boolean };

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

// Sub-pixel slack: zoomed or fractional layouts can stop a pixel short of the true end.
const SLACK = 1;

export function scrollEdges({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): ScrollEdges {
  return {
    above: scrollTop > SLACK,
    below: scrollTop + clientHeight < scrollHeight - SLACK,
  };
}

export function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.above === b.above && a.below === b.below;
}

// A mask that fades content out over `px` at each edge that has more content past it.
// None at rest, so nothing is faded when the list fits or sits at its top.
export function edgeFadeMask({ above, below }: ScrollEdges, px = 14): string | undefined {
  if (!above && !below) return undefined;
  const top = above ? `transparent 0, #000 ${px}px` : "#000 0";
  const bottom = below ? `#000 calc(100% - ${px}px), transparent 100%` : "#000 100%";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}
