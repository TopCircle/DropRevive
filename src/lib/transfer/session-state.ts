/**
 * Pure helpers for the app-level LAN session (lan-session.ts): the timeline cap, unsaved totals,
 * the nav badge, and which fault to nudge when the tab becomes visible again.
 */
import type { LinkFault } from "./recover.ts";
import type { TransferPhase } from "./link.ts";
import type { TimelineEntry } from "./timeline.ts";

/** Most timeline entries kept for one tab; older settled ones are dropped first. */
export const MAX_TIMELINE = 200;
/** Received-but-unsaved bytes held in memory above which the user is warned once. */
export const UNSAVED_WARN_BYTES = 128 * 1024 * 1024;

export type HeldFile = { id: string; bytes: { byteLength: number } };

const OPEN = new Set(["waiting", "confirm", "transfer"]);

/**
 * Drop the oldest entries until at most `max` remain. Open batches and batches that still hold a
 * file the user has not saved are never dropped, so nothing unsaved disappears from view.
 */
export function capTimeline(entries: TimelineEntry[], max: number, holdsUnsaved: (fileId: string) => boolean): TimelineEntry[] {
  if (entries.length <= max) return entries;
  let excess = entries.length - max;
  const kept: TimelineEntry[] = [];
  for (const entry of entries) {
    const pinned = entry.kind === "batch" && (OPEN.has(entry.status) || entry.files.some((file) => holdsUnsaved(file.id)));
    if (excess > 0 && !pinned) {
      excess -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

export function unsavedSummary(saves: readonly HeldFile[], savedIds: ReadonlySet<string>): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const file of saves) {
    if (savedIds.has(file.id)) continue;
    count += 1;
    bytes += file.bytes.byteLength;
  }
  return { count, bytes };
}

/** True once when the unsaved total goes from below the limit to at or above it. */
export function crossedUnsavedLimit(before: number, after: number, limit = UNSAVED_WARN_BYTES): boolean {
  return before < limit && after >= limit;
}

const LIVE: ReadonlySet<TransferPhase> = new Set(["connected", "offering", "confirm", "sending", "receiving"]);

/** The LAN nav item: a dot while two devices are linked, and a count of things waiting for the user. */
export function lanBadge(input: { phase: TransferPhase; unsaved: number; pendingOffers: number }): { live: boolean; count: number } {
  return { live: LIVE.has(input.phase), count: input.unsaved + input.pendingOffers };
}

export function pendingOffers(entries: readonly TimelineEntry[]): number {
  return entries.filter((entry) => entry.kind === "batch" && entry.direction === "in" && entry.status === "confirm").length;
}

/**
 * When the tab comes back to the foreground: which fault to report so recovery starts, or null when
 * the link looks healthy (or there is no opened session to recover).
 */
export function visibleNudge(input: {
  opened: boolean;
  finished: boolean;
  socket: "open" | "connecting" | "closed" | "none";
  channel: string | undefined;
  peer: string | undefined;
}): LinkFault | null {
  if (!input.opened || input.finished) return null;
  if (input.peer === "failed") return "pc-failed";
  if (input.peer === "disconnected") return "pc-disconnected";
  if (input.channel !== undefined && input.channel !== "open") return "dc-close";
  if (input.socket === "closed" || input.socket === "none") return "ws-close";
  return null;
}
