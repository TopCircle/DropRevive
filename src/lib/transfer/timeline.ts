export type BatchFile = { id: string; name: string; size: number };

export type BatchStatus = "waiting" | "confirm" | "transfer" | "done" | "declined" | "failed";

export type TimelineBatch = {
  kind: "batch";
  id: string;
  at: number;
  direction: "out" | "in";
  sender: string;
  text: string;
  textBytes: number;
  files: BatchFile[];
  status: BatchStatus;
  done: number;
  total: number;
};

export type NoticeTone = "connect" | "reconnect" | "end" | "fail" | "info";

export type TimelineNotice = {
  kind: "notice";
  id: string;
  at: number;
  tone: NoticeTone;
  text: string;
};

export type TimelineEntry = TimelineBatch | TimelineNotice;

export type SessionEvent =
  | { type: "offer"; id: string; at: number; sender: string; text: string; files: BatchFile[]; total: number }
  | { type: "incoming"; id: string; at: number; sender: string; textBytes: number; files: BatchFile[]; total: number }
  | { type: "status"; id: string; status: BatchStatus }
  | { type: "progress"; id: string; done: number; total: number }
  | { type: "text"; id: string; text: string }
  | { type: "notice"; at: number; tone: NoticeTone; text: string }
  | { type: "clear-reconnect" }
  | { type: "clear-end" }
  | { type: "clear-stale" }
  | { type: "fail-open" };

const OPEN_STATUS: BatchStatus[] = ["waiting", "confirm", "transfer"];
const SETTLED_STATUS: BatchStatus[] = ["done", "declined", "failed"];

export const CONNECTION_NOTICES: Record<string, NoticeTone> = {
  "transfer.signaling": "reconnect",
  "transfer.reconnecting": "reconnect",
  "transfer.linkLost": "end",
  "transfer.peerLeft": "end",
  "transfer.youLeft": "end",
  "transfer.idleEnded": "end",
  "transfer.hardEnded": "end",
  "transfer.expired": "end",
  "transfer.interrupted": "info",
  "transfer.failed": "fail",
  "transfer.empty": "info",
  "transfer.tooBig": "info",
  "transfer.declined": "info",
};

export function reduceTimeline(entries: TimelineEntry[], event: SessionEvent): TimelineEntry[] {
  if (event.type === "offer") {
    const textBytes = new TextEncoder().encode(event.text).byteLength;
    return [
      ...entries,
      {
        kind: "batch",
        id: event.id,
        at: event.at,
        direction: "out",
        sender: event.sender,
        text: event.text,
        textBytes,
        files: event.files,
        status: "waiting",
        done: 0,
        total: event.total,
      },
    ];
  }
  if (event.type === "incoming") {
    return [
      ...entries,
      {
        kind: "batch",
        id: event.id,
        at: event.at,
        direction: "in",
        sender: event.sender,
        text: "",
        textBytes: event.textBytes,
        files: event.files,
        status: "confirm",
        done: 0,
        total: event.total,
      },
    ];
  }
  if (event.type === "clear-reconnect") {
    return entries.filter((entry) => entry.kind !== "notice" || entry.tone !== "reconnect");
  }
  if (event.type === "clear-stale") {
    // A failure or an ended session from an earlier attempt must not linger once a new one starts or connects.
    return entries.filter((entry) => entry.kind !== "notice" || (entry.tone !== "fail" && entry.tone !== "end"));
  }
  if (event.type === "clear-end") {
    return entries.filter((entry) => entry.kind !== "notice" || entry.tone !== "end");
  }
  if (event.type === "notice") {
    const last = entries[entries.length - 1];
    if (last?.kind === "notice" && last.text === event.text && last.tone === event.tone) return entries;
    return [
      ...entries,
      { kind: "notice", id: `notice-${event.at}-${entries.length}`, at: event.at, tone: event.tone, text: event.text },
    ];
  }
  if (event.type === "fail-open") {
    return entries.map((entry) =>
      entry.kind === "batch" && OPEN_STATUS.includes(entry.status) ? { ...entry, status: "failed" } : entry,
    );
  }
  return entries.map((entry) => {
    if (entry.kind !== "batch" || entry.id !== event.id) return entry;
    if (event.type === "status") return { ...entry, status: event.status };
    if (event.type === "progress") {
      if (SETTLED_STATUS.includes(entry.status)) return entry;
      return { ...entry, done: event.done, total: event.total };
    }
    return { ...entry, text: event.text };
  });
}

export type LinkVisual = "pairing" | "connecting" | "waiting" | "live" | "reconnecting" | "ended" | "failed";

const RECONNECT = new Set(["transfer.signaling", "transfer.reconnecting"]);

export function linkVisual(phase: string, noteKey: string | null): LinkVisual {
  if (phase === "failed") return noteKey === "transfer.failed" ? "failed" : "ended";
  if (phase === "idle") return "pairing";
  if (phase === "hosting") return "waiting";
  if (phase === "joining") return "connecting";
  if (noteKey && RECONNECT.has(noteKey)) return "reconnecting";
  return "live";
}

/** Signaling-only recovery leaves the data channel open, so it does not block a new offer. */
export function offerBlocked(phase: string, noteKey: string | null): boolean {
  return phase !== "connected" || noteKey === "transfer.reconnecting";
}

export function sessionVisible(phase: string): boolean {
  return (
    phase === "connected" ||
    phase === "offering" ||
    phase === "confirm" ||
    phase === "sending" ||
    phase === "receiving" ||
    phase === "failed"
  );
}

export function openBatchFails(noteKey: string | null, phase: string): boolean {
  return phase === "failed" || noteKey === "transfer.interrupted";
}

/** True when the reader is already near the latest entry, so a new one may scroll into view. */
export function stickToEnd(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
