import type { LinkVisual } from "@/lib/transfer/timeline";

/** Chip style for each LAN link state, shared by the transfer panel and its thread. */
export function linkChipClass(visual: LinkVisual): string {
  if (visual === "failed") return "bg-danger/10 text-danger";
  if (visual === "reconnecting") return "bg-muted text-foreground";
  if (visual === "connecting" || visual === "waiting") return "border border-border text-foreground";
  if (visual === "ended") return "border border-dashed border-border text-subtle";
  return "border border-border text-muted-foreground";
}
