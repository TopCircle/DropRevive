import assert from "node:assert/strict";
import test from "node:test";
import type { IceInit, SignalPayload } from "./protocol.ts";
import { emptyNegotiation, emptyOutbox, flushHeld, holdCandidate, holdOffer, noteSignal, rememberAnswer, stageOutgoing } from "./negotiation.ts";

const ice = (candidate: string): IceInit => ({ candidate, sdpMid: "0", sdpMLineIndex: 0 });

function offer(gen: number, fresh: boolean): Extract<SignalPayload, { kind: "offer" }> {
  return { kind: "offer", sdp: `offer-${gen}`, gen, fresh };
}

function answer(gen: number): Extract<SignalPayload, { kind: "answer" }> {
  return { kind: "answer", sdp: `answer-${gen}`, gen };
}

function candidate(gen: number, name: string): Extract<SignalPayload, { kind: "candidate" }> {
  return { kind: "candidate", init: ice(name), gen };
}

test("a fresh offer replaces the peer, including the first generation", () => {
  const first = noteSignal(emptyNegotiation(), offer(1, true), "guest");
  assert.equal(first.effect, "replace-peer");
  assert.equal(first.state.pendingGen, 1);
  assert.equal(first.state.remoteReady, false);
  assert.equal(first.state.answerSdp, null);

  const restarted = noteSignal(rememberAnswer(first.state, "answer-1"), offer(2, false), "guest");
  assert.equal(restarted.effect, "apply-offer");
  const replaced = noteSignal(restarted.state, offer(3, true), "guest");
  assert.equal(replaced.effect, "replace-peer");
  assert.equal(replaced.state.pendingGen, 3);
});

test("the same offer is ignored while its answer is still missing", () => {
  const first = noteSignal(emptyNegotiation(), offer(1, true), "guest");
  const again = noteSignal(first.state, offer(1, true), "guest");
  assert.equal(again.effect, "ignore");
  assert.equal(again.state, first.state);
});

test("a repeated offer resends the stored answer and the description is applied once", () => {
  let descriptions = 0;
  const first = noteSignal(emptyNegotiation(), offer(1, true), "guest");
  if (first.effect === "replace-peer" || first.effect === "apply-offer") descriptions += 1;
  const stored = rememberAnswer(first.state, "answer-sdp");
  assert.equal(stored.answerSdp, "answer-sdp");
  const again = noteSignal(stored, offer(1, true), "guest");
  if (again.effect === "replace-peer" || again.effect === "apply-offer") descriptions += 1;
  assert.equal(again.effect, "resend-answer");
  assert.equal(again.answerSdp, "answer-sdp");
  assert.equal(again.state, stored);
  assert.equal(descriptions, 1);

  const host = noteSignal({ ...emptyNegotiation(), pendingGen: 1 }, answer(1), "host");
  assert.equal(host.effect, "apply-answer");
  assert.equal(host.state.remoteReady, true);
});

test("a newer ice-restart offer clears the previous answer and queued candidates", () => {
  const started = noteSignal(emptyNegotiation(), offer(1, true), "guest").state;
  const queued = noteSignal(started, candidate(1, "old"), "guest");
  assert.equal(queued.effect, "queue-candidate");
  const saved = rememberAnswer(queued.state, "answer-1");
  const restarted = noteSignal(saved, offer(2, false), "guest");
  assert.equal(restarted.effect, "apply-offer");
  assert.equal(restarted.state.answerSdp, null);
  assert.deepEqual(restarted.state.queued, []);
  assert.equal(restarted.state.remoteReady, false);
  const replaced = noteSignal(saved, offer(2, true), "guest");
  assert.equal(replaced.effect, "replace-peer");
  assert.equal(replaced.state.answerSdp, null);
  assert.deepEqual(replaced.state.queued, []);
});

test("an older generation is ignored for offers, answers, and candidates", () => {
  const current = noteSignal(emptyNegotiation(), offer(2, false), "guest").state;
  assert.equal(noteSignal(current, offer(1, true), "guest").effect, "ignore");
  assert.equal(noteSignal(current, offer(1, true), "guest").state, current);
  assert.equal(noteSignal(emptyNegotiation(), offer(1, true), "host").effect, "ignore");
  assert.equal(noteSignal({ ...emptyNegotiation(), pendingGen: 1 }, answer(1), "guest").effect, "ignore");
  const waiting = { ...emptyNegotiation(), pendingGen: 2 };
  assert.equal(noteSignal(waiting, answer(1), "host").effect, "ignore");
  assert.equal(noteSignal(waiting, candidate(1, "stale"), "guest").effect, "ignore");
  assert.deepEqual(noteSignal(waiting, candidate(1, "stale"), "guest").state.queued, []);
});

test("only the current generation is queued before the remote description, then a later answer is ignored", () => {
  const started = noteSignal(emptyNegotiation(), offer(1, true), "guest").state;
  const early = noteSignal(started, candidate(1, "early"), "guest");
  assert.equal(early.effect, "queue-candidate");
  assert.deepEqual(early.state.queued, [ice("early")]);
  const moved = noteSignal(early.state, offer(2, false), "guest");
  assert.deepEqual(moved.state.queued, []);
  assert.equal(noteSignal(moved.state, candidate(1, "early"), "guest").effect, "ignore");
  const current = noteSignal(moved.state, candidate(2, "now"), "guest");
  assert.equal(current.effect, "queue-candidate");
  assert.deepEqual(current.state.queued, [ice("now")]);

  const host = { ...emptyNegotiation(), pendingGen: 2 };
  const applied = noteSignal(host, answer(2), "host");
  assert.equal(applied.effect, "apply-answer");
  const duplicate = noteSignal(applied.state, answer(2), "host");
  assert.equal(duplicate.effect, "ignore");
  assert.equal(duplicate.state, applied.state);
});

test("flushHeld sends nothing and keeps sentGen until the socket is open", () => {
  const offerPayload = offer(2, false);
  const candidatePayload = candidate(2, "c");
  let outbox = holdOffer(emptyOutbox(), offerPayload);
  outbox = holdCandidate(outbox, candidatePayload);
  assert.equal(outbox.sentGen, 0);
  const closed = flushHeld(outbox, false);
  assert.deepEqual(closed.send, []);
  assert.equal(closed.outbox.sentGen, 0);
  assert.equal(closed.outbox, outbox);
  const open = flushHeld(closed.outbox, true);
  assert.deepEqual(open.send, [offerPayload, candidatePayload]);
  assert.equal(open.outbox.sentGen, 2);
});

test("a host candidate waits for its offer, and a guest candidate flushes alone", () => {
  const early = candidate(2, "early");
  const hostWaiting = stageOutgoing(emptyOutbox(), early, "host");
  assert.equal(hostWaiting.flush, false);
  assert.deepEqual(hostWaiting.outbox.candidates, [early]);
  const withOffer = stageOutgoing(hostWaiting.outbox, offer(2, false), "host");
  assert.equal(withOffer.flush, true);
  assert.equal(withOffer.outbox.offer?.gen, 2);
  assert.deepEqual(withOffer.outbox.candidates, [early]);
  const guest = stageOutgoing(emptyOutbox(), candidate(1, "guest"), "guest");
  assert.equal(guest.flush, true);
  assert.equal(guest.outbox.offer, null);
  assert.equal(guest.outbox.candidates.length, 1);
});

test("flushHeld sends a guest candidate that has no offer once the socket is open", () => {
  const candidatePayload = candidate(1, "guest");
  const outbox = holdCandidate(emptyOutbox(), candidatePayload);
  const closed = flushHeld(outbox, false);
  assert.deepEqual(closed.send, []);
  assert.equal(closed.outbox.sentGen, 0);
  assert.equal(closed.outbox.candidates.length, 1);
  const open = flushHeld(closed.outbox, true);
  assert.deepEqual(open.send, [candidatePayload]);
  assert.equal(open.outbox.sentGen, 0);
  assert.deepEqual(open.outbox.candidates, []);
  assert.deepEqual(flushHeld(open.outbox, true).send, []);
});
