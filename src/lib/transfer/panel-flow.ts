import { isRoomCode } from "./code.ts";

export function modeForTransferSearch(search: string): "cloud" | "direct" {
  const incoming = (new URLSearchParams(search).get("transfer") || "").toUpperCase();
  return isRoomCode(incoming) ? "direct" : "cloud";
}

/** Drop a consumed room code from the query so a refresh does not put it back. */
export function withoutTransferSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("transfer");
  const next = params.toString();
  return next ? `?${next}` : "";
}

export async function takeRoomResponse<T>(
  work: () => Promise<T>,
  alive: () => boolean,
): Promise<{ ok: true; value: T } | { ok: false; reason: "thrown" | "unmounted" }> {
  try {
    const value = await work();
    if (!alive()) return { ok: false, reason: "unmounted" };
    return { ok: true, value };
  } catch {
    if (!alive()) return { ok: false, reason: "unmounted" };
    return { ok: false, reason: "thrown" };
  }
}

export function lostSocketNeedsFail(state: { alive: boolean; quiet: boolean; finished: boolean }): boolean {
  return state.alive && !state.quiet && !state.finished;
}

export function receivedWouldDrop(input: { textReady: boolean; pendingFiles: number }): boolean {
  return input.textReady || input.pendingFiles > 0;
}
