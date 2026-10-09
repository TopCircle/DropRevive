import type { IceInit, SignalPayload } from "./protocol.ts";

export type NegEffect =
  | "ignore"
  | "apply-offer"
  | "apply-answer"
  | "queue-candidate"
  | "add-candidate"
  | "replace-peer"
  | "resend-answer";

export type NegState = {
  appliedGen: number;
  pendingGen: number;
  remoteReady: boolean;
  queued: IceInit[];
  answerSdp: string | null;
};

export type NegDecision = {
  state: NegState;
  effect: NegEffect;
  answerSdp?: string;
};

export type HeldOutbox = {
  offer: Extract<SignalPayload, { kind: "offer" }> | null;
  candidates: Array<Extract<SignalPayload, { kind: "candidate" }>>;
  sentGen: number;
};

export function emptyNegotiation(): NegState {
  return { appliedGen: 0, pendingGen: 0, remoteReady: false, queued: [], answerSdp: null };
}

export function rememberAnswer(state: NegState, sdp: string): NegState {
  return { ...state, answerSdp: sdp, appliedGen: state.pendingGen };
}

function unchanged(state: NegState): NegDecision {
  return { state, effect: "ignore" };
}

export function noteSignal(state: NegState, payload: SignalPayload, role: "host" | "guest"): NegDecision {
  if (payload.kind === "offer") {
    if (role !== "guest" || payload.gen < state.pendingGen) return unchanged(state);
    if (payload.gen === state.appliedGen && state.answerSdp !== null) {
      return { state, effect: "resend-answer", answerSdp: state.answerSdp };
    }
    if (payload.gen === state.pendingGen && payload.gen === state.appliedGen) return unchanged(state);
    return {
      state: {
        appliedGen: payload.gen,
        pendingGen: payload.gen,
        remoteReady: false,
        queued: payload.gen === state.pendingGen ? state.queued : [],
        answerSdp: null,
      },
      effect: payload.fresh ? "replace-peer" : "apply-offer",
    };
  }
  if (payload.kind === "answer") {
    if (role !== "host" || payload.gen !== state.pendingGen || payload.gen === state.appliedGen) return unchanged(state);
    return { state: { ...state, appliedGen: payload.gen, remoteReady: true }, effect: "apply-answer" };
  }
  if (payload.gen !== state.pendingGen) return unchanged(state);
  if (!state.remoteReady) {
    return { state: { ...state, queued: [...state.queued, payload.init] }, effect: "queue-candidate" };
  }
  return { state, effect: "add-candidate" };
}

export function emptyOutbox(): HeldOutbox {
  return { offer: null, candidates: [], sentGen: 0 };
}

export function holdOffer(outbox: HeldOutbox, offer: Extract<SignalPayload, { kind: "offer" }>): HeldOutbox {
  return {
    ...outbox,
    offer,
    candidates: outbox.candidates.filter((item) => item.gen === offer.gen),
  };
}

export function holdCandidate(outbox: HeldOutbox, candidate: Extract<SignalPayload, { kind: "candidate" }>): HeldOutbox {
  if (outbox.offer && candidate.gen !== outbox.offer.gen) return outbox;
  return { ...outbox, candidates: [...outbox.candidates, candidate] };
}

export function stageOutgoing(
  outbox: HeldOutbox,
  payload: Exclude<SignalPayload, { kind: "answer" }>,
  role: "host" | "guest",
): { outbox: HeldOutbox; flush: boolean } {
  if (payload.kind === "offer") return { outbox: holdOffer(outbox, payload), flush: true };
  const next = holdCandidate(outbox, payload);
  return { outbox: next, flush: next.offer !== null || role !== "host" };
}

export function flushHeld(outbox: HeldOutbox, socketOpen: boolean): { outbox: HeldOutbox; send: SignalPayload[] } {
  if (!socketOpen) return { outbox, send: [] };
  if (outbox.offer === null) {
    if (outbox.candidates.length === 0) return { outbox, send: [] };
    return { outbox: { ...outbox, candidates: [] }, send: outbox.candidates };
  }
  return { outbox: { ...outbox, sentGen: outbox.offer.gen }, send: [outbox.offer, ...outbox.candidates] };
}
