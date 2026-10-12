import type { MessageKey } from "../i18n/types.ts";
import type { FileAssembler } from "./assemble.ts";
import type { ControlState } from "./control.ts";
import { CONNECT_TIMEOUT_MS, ICE_SETTLE_MS, LEASE_INTERVAL_MS, RECONNECT_GRACE_MS } from "./limits.ts";
import { lostSocketNeedsFail } from "./panel-flow.ts";
import { encodeSignal, type ManifestFile, type ServerSignal, type SignalPayload } from "./protocol.ts";
import { decideLinkFault, type LinkFault } from "./recover.ts";
import { createRecovery } from "./recovery.ts";
import { visibleNudge } from "./session-state.ts";
import { browserPeer, closedSession, connectSession, type DataChannelLike, type PeerLike, type Session } from "./session.ts";

export type TransferPhase = "idle" | "hosting" | "joining" | "connected" | "offering" | "confirm" | "sending" | "receiving" | "failed";

export type TransferLink = {
  alive: boolean;
  role: "host" | "guest" | null;
  roomCode: string;
  token: string;
  socket: WebSocket | null;
  closePeer: (() => void) | null;
  channel: DataChannelLike | null;
  peer: PeerLike | null;
  control: ControlState;
  activeId: string | null;
  manifest: { textBytes: number; files: ManifestFile[] } | null;
  snapshotText: string;
  snapshotFiles: File[];
  assemblers: Map<string, FileAssembler>;
  textAssembler: FileAssembler | null;
  textDone: boolean;
  filesDone: Set<string>;
  got: number;
  total: number;
  session: Promise<Session> | null;
  early: SignalPayload[];
  opened: boolean;
  finished: boolean;
  quiet: boolean;
  stream: MediaStream | null;
  scan: number;
  openTimer: number;
};

export type LanHooks = {
  say(phase: TransferPhase, message?: string): void;
  note(message: string): void;
  text(key: MessageKey): string;
  onData(data: string | ArrayBuffer): void;
  onServer(message: ServerSignal): void;
};

export type LanLink = {
  fail(message: string): void;
  dispose(): void;
  openSocket(role: "host" | "guest", roomCode: string, token: string): void;
  ensureSession(): void;
  takeSignal(payload: SignalPayload): void;
  clearRecovery(): void;
  sendLease(): void;
  syncLease(): void;
  applyFault(fault: LinkFault): void;
  /** The tab is visible again: start recovery if the socket, channel or peer dropped while hidden. */
  nudge(): void;
};

export function freshLink(): TransferLink {
  return {
    alive: true,
    role: null,
    roomCode: "",
    token: "",
    socket: null,
    closePeer: null,
    channel: null,
    peer: null,
    control: "ready",
    activeId: null,
    manifest: null,
    snapshotText: "",
    snapshotFiles: [],
    assemblers: new Map(),
    textAssembler: null,
    textDone: false,
    filesDone: new Set(),
    got: 0,
    total: 0,
    session: null,
    early: [],
    opened: false,
    finished: false,
    quiet: false,
    stream: null,
    scan: 0,
    openTimer: 0,
  };
}

export function stopMedia(link: TransferLink): void {
  if (link.scan) cancelAnimationFrame(link.scan);
  link.scan = 0;
  for (const track of link.stream?.getTracks() ?? []) track.stop();
  link.stream = null;
}

function socketUrl(code: string, token: string): string {
  const url = new URL("/api/transfer/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("code", code);
  url.searchParams.set("token", token);
  return url.toString();
}

function parseServer(raw: string): ServerSignal | null {
  try {
    const value = JSON.parse(raw) as ServerSignal;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function silenceChannel(channel: DataChannelLike | null): void {
  if (!channel) return;
  channel.onopen = null;
  channel.onmessage = null;
  channel.onclose = null;
}

export function createLanLink(linkRef: { current: TransferLink }, hooksRef: { current: LanHooks }): LanLink {
  let preparedRestart = false;
  let batchAborted = false;
  let lastFault: LinkFault = "ws-close";
  let resend = 0;
  let leaseTimer = 0;
  // Socket reconnects back off (1 s, 2 s, 4 s … 30 s) so a long outage does not spin.
  let reconnectTimer = 0;
  let reconnectTries = 0;
  const recovery = createRecovery({
    graceMs: RECONNECT_GRACE_MS,
    settleMs: ICE_SETTLE_MS,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    connectionState: () => linkRef.current.peer?.connectionState,
    onGrace() {
      applyFault(lastFault);
    },
    onSettle() {
      applyFault("pc-disconnected");
    },
  });

  function text(key: MessageKey): string {
    return hooksRef.current.text(key);
  }

  function say(phase: TransferPhase, message = ""): void {
    hooksRef.current.say(phase, message);
  }

  function clearTimers(): void {
    const link = linkRef.current;
    if (link.openTimer) window.clearTimeout(link.openTimer);
    link.openTimer = 0;
    if (resend) window.clearInterval(resend);
    resend = 0;
    if (leaseTimer) window.clearInterval(leaseTimer);
    leaseTimer = 0;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    reconnectTries = 0;
    recovery.clear();
  }

  function cancelRoom(): void {
    const link = linkRef.current;
    if (!link.socket || link.socket.readyState !== WebSocket.OPEN) return;
    link.socket.send(encodeSignal({ type: "cancel", token: link.token }));
  }

  function release(): void {
    const link = linkRef.current;
    const alive = link.alive;
    clearTimers();
    silenceChannel(link.channel);
    link.closePeer?.();
    const socket = link.socket;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    stopMedia(link);
    Object.assign(link, freshLink());
    link.alive = alive;
  }

  function fail(message: string): void {
    const link = linkRef.current;
    if (!link.alive || link.finished || link.quiet) return;
    link.finished = true;
    link.quiet = true;
    clearTimers();
    cancelRoom();
    release();
    link.finished = true;
    link.quiet = true;
    preparedRestart = false;
    batchAborted = false;
    recovery.reset();
    say("failed", message);
  }

  function dispose(): void {
    const link = linkRef.current;
    link.alive = false;
    link.quiet = true;
    clearTimers();
    preparedRestart = false;
    batchAborted = false;
    recovery.reset();
    stopMedia(link);
    link.closePeer?.();
    link.socket?.close();
  }

  function sendLease(): void {
    const link = linkRef.current;
    if (!link.socket || link.socket.readyState !== WebSocket.OPEN || !link.token) return;
    link.socket.send(encodeSignal({ type: "lease", token: link.token }));
  }

  function syncLease(): void {
    const link = linkRef.current;
    const transferring = link.control === "sending" || link.control === "receiving";
    if (!transferring) {
      if (leaseTimer) window.clearInterval(leaseTimer);
      leaseTimer = 0;
      return;
    }
    if (leaseTimer) return;
    leaseTimer = window.setInterval(() => {
      const live = linkRef.current;
      if (live.control !== "sending" && live.control !== "receiving") {
        syncLease();
        return;
      }
      sendLease();
    }, LEASE_INTERVAL_MS);
  }

  function abortBatch(): void {
    const link = linkRef.current;
    const busy = link.control === "outgoing" || link.control === "incoming" || link.control === "sending" || link.control === "receiving";
    if (!busy) return;
    batchAborted = true;
    link.control = "ready";
    link.activeId = null;
    link.manifest = null;
    link.assemblers = new Map();
    link.textAssembler = null;
    link.textDone = false;
    link.filesDone = new Set();
    syncLease();
    say("connected", text("transfer.reconnecting"));
  }

  function noteRecovered(): void {
    const link = linkRef.current;
    if (!link.opened || (!recovery.recovering && !batchAborted)) return;
    if (link.socket?.readyState !== WebSocket.OPEN) return;
    if (link.channel?.readyState !== "open") return;
    if (link.peer?.connectionState !== "connected") return;
    if (recovery.recovering) recovery.reset();
    preparedRestart = false;
    if (batchAborted) {
      batchAborted = false;
      link.control = "ready";
      say("connected", text("transfer.interrupted"));
      return;
    }
    if (link.control === "ready") say("connected", text("transfer.connected"));
    else if (link.control === "sending") say("sending");
    else if (link.control === "receiving") say("receiving");
    else if (link.control === "outgoing") say("offering", text("transfer.waitingAccept"));
    else say("confirm");
  }

  function postSignal(payload: SignalPayload): void {
    const link = linkRef.current;
    if (!link.socket || link.socket.readyState !== WebSocket.OPEN) return;
    link.socket.send(encodeSignal({ type: "signal", token: link.token, payload }));
  }

  function reconnectSocket(): void {
    const link = linkRef.current;
    if (!link.role || !link.roomCode || !link.token) return;
    if (link.socket?.readyState === WebSocket.CONNECTING || reconnectTimer) return;
    if (reconnectTries > 0) {
      const delay = Math.min(30_000, 1000 * 2 ** (reconnectTries - 1));
      reconnectTries += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = 0;
        const live = linkRef.current;
        if (!live.alive || live.finished || live.quiet) return;
        reopenSocket();
      }, delay);
      return;
    }
    reconnectTries = 1;
    reopenSocket();
  }

  function reopenSocket(): void {
    const link = linkRef.current;
    if (!link.role || !link.roomCode || !link.token) return;
    const previous = link.socket;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
    }
    openSocket(link.role, link.roomCode, link.token);
  }

  function applyFault(fault: LinkFault): void {
    const link = linkRef.current;
    if (!link.alive || link.finished || link.quiet) return;
    lastFault = fault;
    const decision = decideLinkFault({
      opened: link.opened,
      recovering: recovery.recovering,
      graceExpired: recovery.graceExpired,
      channelOpen: link.channel?.readyState === "open",
      preparedRestart,
      settleElapsed: recovery.settleElapsed,
      fault,
    });
    if (decision.action === "ignore") return;
    if (decision.action === "fail-initial") {
      fail(text("transfer.failed"));
      return;
    }
    if (decision.action === "give-up") {
      fail(text("transfer.linkLost"));
      return;
    }
    if (decision.action === "reconnect-socket") {
      if (link.opened) {
        recovery.ensure(true);
        hooksRef.current.note(text("transfer.signaling"));
      }
      reconnectSocket();
      return;
    }
    if (decision.action === "arm-settle") {
      // Disconnected often clears by itself while the data channel stays open.
      recovery.ensure(true);
      recovery.armSettle();
      return;
    }
    recovery.ensure(true);
    if (decision.fresh || link.channel?.readyState !== "open") hooksRef.current.note(text("transfer.reconnecting"));
    if (decision.fresh) abortBatch();
    if (link.socket?.readyState !== WebSocket.OPEN) reconnectSocket();
    if (link.role === "host") void renegotiate(decision.fresh);
  }

  async function renegotiate(fresh: boolean): Promise<void> {
    const link = linkRef.current;
    if (preparedRestart || link.role !== "host" || link.finished) return;
    preparedRestart = true;
    const token = link.token;
    const session = link.session ? await link.session : null;
    const live = linkRef.current;
    if (!session || live.finished || live.token !== token) return;
    if (fresh) abortBatch();
    try {
      await session.renegotiate(fresh);
    } catch {
      return;
    }
  }

  function markOpen(link: TransferLink): void {
    if (link.opened) return;
    link.opened = true;
    link.control = "ready";
    link.activeId = null;
    if (link.openTimer) window.clearTimeout(link.openTimer);
    link.openTimer = 0;
    say("connected", text("transfer.connected"));
  }

  function armChannel(channel: DataChannelLike): void {
    const link = linkRef.current;
    link.channel = channel;
    channel.onmessage = (event) => hooksRef.current.onData(event.data);
    const open = () => {
      const live = linkRef.current;
      if (!live.alive || live.channel !== channel) return;
      markOpen(live);
      noteRecovered();
    };
    if (channel.readyState === "open") open();
    else {
      channel.onopen = open;
      if (!link.opened && !link.openTimer) {
        link.openTimer = window.setTimeout(() => {
          if (!linkRef.current.opened) fail(text("transfer.failed"));
        }, CONNECT_TIMEOUT_MS);
      }
    }
  }

  function deliver(session: Session, payload: SignalPayload): void {
    const link = linkRef.current;
    if (link.finished || link.quiet) return;
    if (session.replacing(payload)) abortBatch();
    void session.acceptSignal(payload).then(() => noteRecovered());
  }

  function takeSignal(payload: SignalPayload): void {
    const link = linkRef.current;
    if (!link.alive || link.finished || link.quiet) return;
    if (!link.session) {
      link.early.push(payload);
      return;
    }
    void link.session.then((session) => deliver(session, payload));
  }

  function ensureSession(): void {
    const link = linkRef.current;
    if (link.session || !link.role) return;
    const role = link.role;
    const token = link.token;
    link.control = "ready";
    link.session = connectSession({
      role,
      createPeer: browserPeer,
      sendSignal: postSignal,
      isSocketOpen: () => linkRef.current.socket?.readyState === WebSocket.OPEN,
      onPeer(peer) {
        const live = linkRef.current;
        live.peer = peer;
        live.closePeer = () => peer.close();
      },
      onConnectionState(state, peer) {
        const live = linkRef.current;
        if (live.peer !== peer) live.peer = peer;
        if (state === "disconnected") applyFault("pc-disconnected");
        else if (state === "failed") applyFault("pc-failed");
        else if (state === "closed") applyFault("pc-closed");
        else if (state === "connected") {
          recovery.connected();
          noteRecovered();
        }
      },
      onChannel: armChannel,
      onChannelClose() {
        applyFault("dc-close");
      },
    })
      .then((session) => {
        const live = linkRef.current;
        if (!live.alive || live.finished || live.quiet || live.token !== token) {
          session.close();
          return session;
        }
        live.closePeer = () => session.close();
        const queued = live.early.splice(0);
        for (const payload of queued) deliver(session, payload);
        void session.waitChannel().catch(() => {
          const current = linkRef.current;
          if (!current.opened && current.alive && !current.finished && !current.quiet && current.token === token) fail(text("transfer.failed"));
        });
        if (!resend) {
          resend = window.setInterval(() => {
            const current = linkRef.current;
            if (!current.alive || current.finished || !current.session) return;
            void current.session.then((active) => {
              if (active.needsResend()) active.flush();
            });
          }, 1000);
        }
        return session;
      })
      .catch(() => {
        const live = linkRef.current;
        if (live.alive && !live.finished && !live.quiet && live.token === token) fail(text("transfer.failed"));
        return closedSession();
      });
  }

  function openSocket(role: "host" | "guest", roomCode: string, token: string): void {
    const link = linkRef.current;
    link.role = role;
    link.roomCode = roomCode;
    link.token = token;
    const socket = new WebSocket(socketUrl(roomCode, token));
    link.socket = socket;
    socket.onopen = () => {
      reconnectTries = 0;
      const pending = linkRef.current.session;
      if (pending) void pending.then((session) => session.flush());
      noteRecovered();
    };
    socket.onmessage = (event) => {
      const message = parseServer(String(event.data));
      if (message) hooksRef.current.onServer(message);
    };
    socket.onerror = () => applyFault("ws-error");
    socket.onclose = () => {
      const current = linkRef.current;
      if (!lostSocketNeedsFail({ alive: current.alive, quiet: current.quiet, finished: current.finished })) return;
      if (current.socket !== socket) return;
      applyFault("ws-close");
    };
  }

  return {
    fail,
    dispose,
    openSocket,
    ensureSession,
    takeSignal,
    clearRecovery() {
      recovery.clear();
    },
    sendLease,
    syncLease,
    applyFault,
    nudge() {
      const link = linkRef.current;
      if (!link.alive || link.quiet) return;
      const state = link.socket?.readyState;
      const socket =
        state === undefined ? "none" : state === WebSocket.OPEN ? "open" : state === WebSocket.CONNECTING ? "connecting" : "closed";
      const fault = visibleNudge({
        opened: link.opened,
        finished: link.finished,
        socket,
        channel: link.channel?.readyState,
        peer: link.peer?.connectionState,
      });
      if (fault) applyFault(fault);
    },
  };
}
