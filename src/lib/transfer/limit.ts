export type Hit = { windowStart: number; count: number };

export function allowHit(state: Hit | null, now: number, limit: number, windowMs: number): { ok: boolean; next: Hit } {
  if (!state || now - state.windowStart >= windowMs) {
    return { ok: true, next: { windowStart: now, count: 1 } };
  }
  if (state.count >= limit) return { ok: false, next: state };
  return { ok: true, next: { windowStart: state.windowStart, count: state.count + 1 } };
}
