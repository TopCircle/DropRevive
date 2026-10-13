import { CONNECT_TIMEOUT_MS, ICE_TIMEOUT_MS } from "./limits.ts";
import { emptyNegotiation, emptyOutbox, flushHeld, noteSignal, rememberAnswer, stageOutgoing, type HeldOutbox, type NegState } from "./negotiation.ts";
import type { IceInit, SignalPayload } from "./protocol.ts";
import { PEER_CONFIG } from "./ice.ts";

export interface DataChannelLike {
  readyState: string;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  bufferedAmount?: number;
}

export interface PeerLike {
  config: RTCConfiguration | null;
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  connectionState?: RTCPeerConnectionState;
  createDataChannel(label: string): DataChannelLike;
  createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export function exposePeer(native: object, config: RTCConfiguration): PeerLike {
  return new Proxy(native, {
    get(target, prop) {
      if (prop === "config") return config;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  }) as unknown as PeerLike;
}

export function browserPeer(config: RTCConfiguration): PeerLike {
  return exposePeer(new RTCPeerConnection(config), config);
}

function signalInit(init: RTCIceCandidateInit): IceInit | null {
  if (typeof init.candidate !== "string" || init.candidate.length === 0) return null;
  const ice: IceInit = {
    candidate: init.candidate,
    sdpMid: init.sdpMid ?? null,
    sdpMLineIndex: init.sdpMLineIndex ?? null,
  };
  if (init.usernameFragment !== undefined) ice.usernameFragment = init.usernameFragment;
  return ice;
}

export type Session = {
  peer: PeerLike;
  waitChannel: () => Promise<DataChannelLike>;
  acceptSignal: (payload: SignalPayload) => Promise<void>;
  beginGeneration: (input: { gen: number; fresh: boolean; peer?: PeerLike }) => void;
  renegotiate: (fresh: boolean) => Promise<void>;
  flush: () => void;
  needsResend: () => boolean;
  replacing: (payload: SignalPayload) => boolean;
  close: () => void;
};

function silenceChannel(channel: DataChannelLike | null): void {
  if (!channel) return;
  channel.onopen = null;
  channel.onmessage = null;
  channel.onclose = null;
}

const closedChannel: DataChannelLike = {
  readyState: "closed",
  binaryType: "arraybuffer",
  send() {},
  close() {},
  onopen: null,
  onmessage: null,
  onclose: null,
};

const closedPeer: PeerLike = {
  config: null,
  onicecandidate: null,
  onconnectionstatechange: null,
  ondatachannel: null,
  connectionState: "closed",
  createDataChannel() {
    return closedChannel;
  },
  async createOffer() {
    return { type: "offer", sdp: "" };
  },
  async createAnswer() {
    return { type: "answer", sdp: "" };
  },
  async setLocalDescription() {},
  async setRemoteDescription() {},
  async addIceCandidate() {},
  close() {},
};

export function closedSession(): Session {
  return {
    get peer() {
      return closedPeer;
    },
    waitChannel: () => Promise.reject(new Error("failed")),
    acceptSignal: async () => undefined,
    beginGeneration() {},
    renegotiate: async () => undefined,
    flush() {},
    needsResend: () => false,
    replacing: () => false,
    close() {},
  };
}

export async function connectSession(input: {
  role: "host" | "guest";
  createPeer: (config: RTCConfiguration) => PeerLike;
  sendSignal: (payload: SignalPayload) => void;
  isSocketOpen?: () => boolean;
  onPeer?: (peer: PeerLike) => void;
  onConnectionState?: (state: RTCPeerConnectionState | undefined, peer: PeerLike) => void;
  onChannel?: (channel: DataChannelLike) => void;
  onChannelClose?: () => void;
}): Promise<Session> {
  let peer = input.createPeer({ ...PEER_CONFIG });
  let currentGen = 1;
  let neg: NegState = emptyNegotiation();
  let channel: DataChannelLike | null = null;
  let outbox: HeldOutbox = emptyOutbox();
  let answerApplied = false;
  const held: Array<{ gen: number; init: IceInit }> = [];
  const waiters: Array<(value: DataChannelLike) => void> = [];
  const socketOpen = () => (input.isSocketOpen ? input.isSocketOpen() : true);
  const flush = () => {
    if (input.role === "host" && outbox.offer === null) return;
    const flushed = flushHeld(outbox, socketOpen());
    outbox = flushed.outbox;
    for (const payload of flushed.send) input.sendSignal(payload);
  };
  const emit = (payload: SignalPayload) => {
    if (payload.kind === "answer") {
      if (socketOpen()) input.sendSignal(payload);
      return;
    }
    const staged = stageOutgoing(outbox, payload, input.role);
    outbox = staged.outbox;
    if (payload.kind === "offer") answerApplied = false;
    if (staged.flush) flush();
  };
  const publish = (value: DataChannelLike) => {
    if (channel && channel !== value) silenceChannel(channel);
    channel = value;
    value.binaryType = "arraybuffer";
    input.onChannel?.(value);
    value.onclose = () => {
      if (channel !== value) return;
      input.onChannelClose?.();
    };
    for (const waiter of waiters.splice(0)) waiter(value);
  };
  const detach = (target: PeerLike) => {
    target.onicecandidate = null;
    target.onconnectionstatechange = null;
    target.ondatachannel = null;
  };
  const watch = (target: PeerLike) => {
    target.config = { ...PEER_CONFIG };
    target.onicecandidate = (event) => {
      if (target !== peer) return;
      const init = event.candidate?.toJSON();
      if (!init) return;
      const ice = signalInit(init);
      if (!ice) return;
      emit({ kind: "candidate", init: ice, gen: currentGen });
    };
    target.onconnectionstatechange = () => {
      if (target !== peer) return;
      input.onConnectionState?.(target.connectionState, target);
    };
    target.ondatachannel = (event) => {
      if (target !== peer) return;
      publish(event.channel);
    };
  };
  const takeHeld = (gen: number): IceInit[] => {
    const matched = held.filter((item) => item.gen === gen).map((item) => item.init);
    held.splice(0, held.length, ...held.filter((item) => item.gen > gen));
    return matched;
  };
  const beginGeneration = (next: { gen: number; fresh: boolean; peer?: PeerLike }) => {
    currentGen = next.gen;
    outbox = emptyOutbox();
    answerApplied = false;
    neg = {
      appliedGen: 0,
      pendingGen: next.gen,
      remoteReady: false,
      queued: takeHeld(next.gen),
      answerSdp: null,
    };
    if (!next.fresh || !next.peer) return;
    silenceChannel(channel);
    channel = null;
    const previous = peer;
    detach(previous);
    previous.close();
    peer = next.peer;
    watch(peer);
    input.onPeer?.(peer);
    if (input.role === "host") publish(peer.createDataChannel("drop"));
  };
  const prepareOffer = (payload: SignalPayload) => {
    if (payload.kind !== "offer" || input.role !== "guest") return;
    if (payload.gen <= neg.pendingGen) return;
    const replacement = payload.fresh && neg.pendingGen > 0 ? input.createPeer({ ...PEER_CONFIG }) : undefined;
    beginGeneration({ gen: payload.gen, fresh: payload.fresh, peer: replacement });
  };
  watch(peer);
  input.onPeer?.(peer);
  if (input.role === "host") publish(peer.createDataChannel("drop"));
  let chain = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    const run = chain.then(work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  if (input.role === "host") {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    emit({ kind: "offer", sdp: offer.sdp || "", gen: 1, fresh: true });
    neg = { ...neg, pendingGen: 1 };
  }
  return {
    get peer() {
      return peer;
    },
    waitChannel: () => {
      if (channel) return Promise.resolve(channel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("channel-timeout")), CONNECT_TIMEOUT_MS);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    acceptSignal: (payload) =>
      enqueue(async () => {
        prepareOffer(payload);
        const decision = noteSignal(neg, payload, input.role);
        if (decision.effect === "ignore") {
          if (payload.kind === "candidate" && payload.gen > neg.pendingGen) held.push({ gen: payload.gen, init: payload.init });
          return;
        }
        if (decision.effect === "resend-answer" && payload.kind === "offer") {
          emit({ kind: "answer", sdp: decision.answerSdp || "", gen: payload.gen });
          return;
        }
        if (decision.effect === "queue-candidate") {
          neg = decision.state;
          return;
        }
        if (decision.effect === "add-candidate" && payload.kind === "candidate") {
          neg = decision.state;
          await peer.addIceCandidate(payload.init);
          return;
        }
        if ((decision.effect === "replace-peer" || decision.effect === "apply-offer") && payload.kind === "offer") {
          neg = decision.state;
          currentGen = payload.gen;
          await peer.setRemoteDescription({ type: "offer", sdp: payload.sdp });
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          const queued = [...neg.queued, ...takeHeld(payload.gen)];
          neg = { ...rememberAnswer(neg, answer.sdp || ""), remoteReady: true, queued: [] };
          for (const init of queued) await peer.addIceCandidate(init);
          emit({ kind: "answer", sdp: answer.sdp || "", gen: payload.gen });
          return;
        }
        if (decision.effect === "apply-answer" && payload.kind === "answer") {
          answerApplied = true;
          const queued = [...decision.state.queued, ...takeHeld(payload.gen)];
          neg = { ...decision.state, queued: [] };
          await peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          for (const init of queued) await peer.addIceCandidate(init);
        }
      }),
    beginGeneration,
    async renegotiate(fresh) {
      if (input.role !== "host") return;
      const gen = Math.min(255, (currentGen || 1) + 1);
      try {
        if (fresh) {
          const next = input.createPeer({ ...PEER_CONFIG });
          beginGeneration({ gen, fresh: true, peer: next });
          const offer = await next.createOffer();
          await next.setLocalDescription(offer);
          emit({ kind: "offer", sdp: offer.sdp || "", gen, fresh: true });
        } else {
          beginGeneration({ gen, fresh: false });
          const offer = await peer.createOffer({ iceRestart: true });
          await peer.setLocalDescription(offer);
          emit({ kind: "offer", sdp: offer.sdp || "", gen, fresh: false });
        }
      } catch {
        return;
      }
    },
    flush,
    needsResend: () => outbox.offer !== null && !answerApplied,
    replacing(payload) {
      return payload.kind === "offer" && input.role === "guest" && payload.fresh && payload.gen > neg.pendingGen && neg.pendingGen > 0;
    },
    close: () => peer.close(),
  };
}

export const iceGiveUpMs = ICE_TIMEOUT_MS;
