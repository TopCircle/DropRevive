export type LinkFault = "ws-error" | "ws-close" | "pc-disconnected" | "pc-failed" | "pc-closed" | "dc-close";

export type LinkFaultInput = {
  opened: boolean;
  recovering: boolean;
  graceExpired: boolean;
  channelOpen: boolean;
  preparedRestart: boolean;
  settleElapsed: boolean;
  fault: LinkFault;
};

export type LinkFaultAction =
  | { action: "ignore" }
  | { action: "fail-initial" }
  | { action: "reconnect-socket" }
  | { action: "arm-settle" }
  | { action: "renegotiate"; fresh: boolean }
  | { action: "give-up" };

function peerDead(fault: LinkFault): boolean {
  return fault === "pc-failed" || fault === "pc-closed" || fault === "dc-close";
}

export function decideLinkFault(input: LinkFaultInput): LinkFaultAction {
  if (input.opened && input.graceExpired) return { action: "give-up" };
  if (!input.opened && (input.fault === "ws-error" || input.fault === "ws-close")) return { action: "reconnect-socket" };
  if (!input.opened && input.fault === "pc-disconnected") return { action: "ignore" };
  if (!input.opened && peerDead(input.fault)) return { action: "fail-initial" };
  if (input.recovering && input.fault === "ws-close") return { action: "ignore" };
  if (input.preparedRestart && (peerDead(input.fault) || input.fault === "pc-disconnected")) return { action: "ignore" };
  if (input.fault === "ws-error" || input.fault === "ws-close") return { action: "reconnect-socket" };
  if (input.fault === "pc-disconnected" && !input.settleElapsed) return { action: "arm-settle" };
  if (input.fault === "pc-disconnected" && input.channelOpen) return { action: "renegotiate", fresh: false };
  if (peerDead(input.fault)) return { action: "renegotiate", fresh: true };
  return { action: "ignore" };
}
