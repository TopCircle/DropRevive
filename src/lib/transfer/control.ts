import type { ControlMessage } from "./protocol.ts";

/** A live room stays in one of these until a peer disconnects. */
export type ControlState = "ready" | "outgoing" | "incoming" | "sending" | "receiving";

export type LiveControl = {
  state: ControlState;
  /** Offer we sent, or the offer we are confirming or receiving. */
  id: string | null;
};

export type RemoteAction = "show" | "reject-theirs" | "accepted" | "declined" | "finished" | "ignore";

const ready: LiveControl = { state: "ready", id: null };

/**
 * One batch at a time, in either direction. A smaller offer id wins if both
 * sides send before either has accepted. Completing a batch returns to ready
 * and leaves the data channel open.
 */
export function onRemoteControl(live: LiveControl, message: ControlMessage): { next: LiveControl; action: RemoteAction } {
  if (message.t === "manifest") {
    if (live.state === "ready") return { next: { state: "incoming", id: message.id }, action: "show" };
    if (live.state === "outgoing" && live.id) {
      if (message.id < live.id) return { next: { state: "incoming", id: message.id }, action: "show" };
      if (message.id > live.id) return { next: live, action: "reject-theirs" };
      return { next: live, action: "ignore" };
    }
    if (live.state === "incoming" || live.state === "sending" || live.state === "receiving") {
      return { next: live, action: "reject-theirs" };
    }
    return { next: live, action: "ignore" };
  }
  if (message.t === "accept") {
    if (live.state === "outgoing" && message.id === live.id) return { next: { state: "sending", id: live.id }, action: "accepted" };
    return { next: live, action: "ignore" };
  }
  if (message.t === "reject") {
    if (live.state === "outgoing" && message.id === live.id) return { next: ready, action: "declined" };
    return { next: live, action: "ignore" };
  }
  if (live.state === "sending" && message.id === live.id) return { next: ready, action: "finished" };
  return { next: live, action: "ignore" };
}
