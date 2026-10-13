import assert from "node:assert/strict";
import test from "node:test";
import { ICE_SERVERS } from "./ice.ts";
import { connectSession, exposePeer, type DataChannelLike, type PeerLike } from "./session.ts";

test("event handler setters run against the native peer", () => {
  let setOnNative = false;
  let stored: unknown = null;
  const native = {};
  Object.defineProperty(native, "onicecandidate", {
    configurable: true,
    set(value) {
      setOnNative = this === native;
      stored = value;
    },
    get() {
      return stored;
    },
  });
  const peer = exposePeer(native, { iceServers: [] });
  const handler = () => undefined;
  peer.onicecandidate = handler;
  assert.equal(setOnNative, true);
  assert.equal(stored, handler);
});

test("host sends an offer and applies the guest answer with public STUN only (no TURN)", async () => {
  const sent: unknown[] = [];
  let remote: unknown = null;
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription(desc) {
      remote = desc;
    },
    async addIceCandidate() {},
    close() {},
  };
  const session = await connectSession({
    role: "host",
    createPeer: (config) => {
      peer.config = config;
      return peer;
    },
    sendSignal: (payload) => sent.push(payload),
  });
  await session.acceptSignal({ kind: "answer", sdp: "answer-sdp", gen: 1 });
  assert.deepEqual(peer.config, { iceServers: ICE_SERVERS });
  const urls = ICE_SERVERS.flatMap((s) => [s.urls].flat());
  assert.ok(urls.length > 0 && urls.every((u) => u.startsWith("stun:")));
  assert.deepEqual(sent[0], { kind: "offer", sdp: "offer-sdp", gen: 1, fresh: true });
  assert.deepEqual(remote, { type: "answer", sdp: "answer-sdp" });
  peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "c", sdpMid: "0", sdpMLineIndex: 1, usernameFragment: "u" }) } });
  assert.deepEqual(sent.at(-1), { kind: "candidate", init: { candidate: "c", sdpMid: "0", sdpMLineIndex: 1, usernameFragment: "u" }, gen: 1 });
});

test("a candidate that arrives before the answer is added with sdpMid afterwards", async () => {
  const added: RTCIceCandidateInit[] = [];
  let release = () => {};
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async addIceCandidate(init) {
      added.push(init);
    },
    close() {},
  };
  const session = await connectSession({
    role: "host",
    createPeer: () => peer,
    sendSignal: () => undefined,
  });
  const init = { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 };
  const answering = session.acceptSignal({ kind: "answer", sdp: "answer-sdp", gen: 1 });
  const early = session.acceptSignal({ kind: "candidate", init, gen: 1 });
  await Promise.resolve();
  assert.equal(added.length, 0);
  release();
  await answering;
  await early;
  assert.deepEqual(added, [init]);
});

test("guest applies a full candidate only after the offer is set", async () => {
  const added: RTCIceCandidateInit[] = [];
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate(init) {
      added.push(init);
    },
    close() {},
  };
  const sent: unknown[] = [];
  const session = await connectSession({
    role: "guest",
    createPeer: () => peer,
    sendSignal: (payload) => sent.push(payload),
  });
  const init = { candidate: "c", sdpMid: null, sdpMLineIndex: 0 };
  const early = session.acceptSignal({ kind: "candidate", init, gen: 1 });
  await Promise.resolve();
  assert.equal(added.length, 0);
  await session.acceptSignal({ kind: "offer", sdp: "offer-sdp", gen: 1, fresh: true });
  await early;
  assert.deepEqual(added, [init]);
  assert.deepEqual(sent[0], { kind: "answer", sdp: "answer-sdp", gen: 1 });
});

test("addIceCandidate failure rejects acceptSignal", async () => {
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate() {
      throw new Error("ice-failed");
    },
    close() {},
  };
  const session = await connectSession({
    role: "host",
    createPeer: () => peer,
    sendSignal: () => undefined,
  });
  await session.acceptSignal({ kind: "answer", sdp: "answer-sdp", gen: 1 });
  await assert.rejects(
    session.acceptSignal({ kind: "candidate", init: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 }, gen: 1 }),
    /ice-failed/,
  );
});

test("a repeated offer resends one answer and applies the remote description once", async () => {
  let descriptions = 0;
  const sent: unknown[] = [];
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {
      descriptions += 1;
    },
    async addIceCandidate() {},
    close() {},
  };
  const session = await connectSession({
    role: "guest",
    createPeer: () => peer,
    sendSignal: (payload) => sent.push(payload),
  });
  const offer = { kind: "offer" as const, sdp: "offer-sdp", gen: 1, fresh: true };
  await session.acceptSignal(offer);
  await session.acceptSignal(offer);
  assert.equal(descriptions, 1);
  assert.deepEqual(sent, [
    { kind: "answer", sdp: "answer-sdp", gen: 1 },
    { kind: "answer", sdp: "answer-sdp", gen: 1 },
  ]);
});

test("beginGeneration holds candidates until that generation's answer, and drops the previous generation", async () => {
  const added: RTCIceCandidateInit[] = [];
  let channels = 0;
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      channels += 1;
      return { readyState: "open", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate(init) {
      added.push(init);
    },
    close() {},
  };
  const session = await connectSession({
    role: "host",
    createPeer: () => peer,
    sendSignal: () => undefined,
  });
  await session.acceptSignal({ kind: "answer", sdp: "answer-sdp", gen: 1 });
  session.beginGeneration({ gen: 2, fresh: false });
  assert.equal(channels, 1);
  const first = { candidate: "a", sdpMid: "0", sdpMLineIndex: 0 };
  const second = { candidate: "b", sdpMid: "0", sdpMLineIndex: 1 };
  const stale = { candidate: "old", sdpMid: "0", sdpMLineIndex: 0 };
  await session.acceptSignal({ kind: "candidate", init: first, gen: 2 });
  await session.acceptSignal({ kind: "candidate", init: second, gen: 2 });
  await session.acceptSignal({ kind: "candidate", init: stale, gen: 1 });
  assert.deepEqual(added, []);
  await session.acceptSignal({ kind: "answer", sdp: "next-sdp", gen: 2 });
  assert.deepEqual(added, [first, second]);
});

test("a fresh generation closes the old host peer and publishes the new channel", async () => {
  const channel = () => ({ readyState: "open", send() {}, close() {}, binaryType: "arraybuffer" as const, onopen: null, onmessage: null, onclose: null });
  const firstChannel = channel();
  const secondChannel = channel();
  let closed = 0;
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      return firstChannel;
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate() {},
    close() {
      closed += 1;
    },
  };
  let created = 0;
  const next: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel() {
      created += 1;
      return secondChannel;
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate() {},
    close() {},
  };
  const sent: unknown[] = [];
  const session = await connectSession({
    role: "host",
    createPeer: () => peer,
    sendSignal: (payload) => sent.push(payload),
  });
  assert.equal(await session.waitChannel(), firstChannel);
  const before = sent.length;
  session.beginGeneration({ gen: 2, fresh: true, peer: next });
  assert.equal(closed, 1);
  assert.equal(created, 1);
  assert.equal(await session.waitChannel(), secondChannel);
  peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "old", sdpMid: "0", sdpMLineIndex: 0 }) } });
  next.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "new", sdpMid: "0", sdpMLineIndex: 0 }) } });
  assert.deepEqual(sent.slice(before), []);
});

function stubPeer(): PeerLike & { closed: number; offered: Array<{ iceRestart?: boolean } | undefined>; described: unknown[] } {
  const peer = {
    config: null as RTCConfiguration | null,
    onicecandidate: null as PeerLike["onicecandidate"],
    onconnectionstatechange: null as PeerLike["onconnectionstatechange"],
    ondatachannel: null as PeerLike["ondatachannel"],
    closed: 0,
    offered: [] as Array<{ iceRestart?: boolean } | undefined>,
    described: [] as unknown[],
    createDataChannel(): DataChannelLike {
      return { readyState: "connecting", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
    },
    async createOffer(options?: { iceRestart?: boolean }) {
      peer.offered.push(options);
      return { type: "offer" as const, sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer" as const, sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      peer.described.push(desc);
    },
    async addIceCandidate() {},
    close() {
      peer.closed += 1;
    },
  };
  return peer;
}

test("a later fresh offer replaces the guest peer and a repeat does not", async () => {
  const first = stubPeer();
  const second = stubPeer();
  const peers = [first, second];
  const sent: unknown[] = [];
  const session = await connectSession({
    role: "guest",
    createPeer: () => peers.shift() ?? second,
    sendSignal: (payload) => sent.push(payload),
  });
  await session.acceptSignal({ kind: "offer", sdp: "one", gen: 1, fresh: true });
  await session.acceptSignal({ kind: "offer", sdp: "one", gen: 1, fresh: true });
  assert.equal(first.closed, 0);
  assert.equal(first.described.length, 1);
  assert.equal(session.replacing({ kind: "offer", sdp: "two", gen: 2, fresh: true }), true);
  await session.acceptSignal({ kind: "offer", sdp: "two", gen: 2, fresh: true });
  assert.equal(first.closed, 1);
  assert.deepEqual(second.described, [{ type: "offer", sdp: "two" }]);
  assert.equal(sent.filter((item) => (item as { kind?: string }).kind === "answer").length, 3);
});

test("an older fresh offer does not replace the guest peer", async () => {
  const first = stubPeer();
  const second = stubPeer();
  const peers = [first, second];
  const sent: unknown[] = [];
  const session = await connectSession({
    role: "guest",
    createPeer: () => peers.shift() ?? second,
    sendSignal: (payload) => sent.push(payload),
  });
  await session.acceptSignal({ kind: "offer", sdp: "two", gen: 2, fresh: true });
  assert.equal(session.replacing({ kind: "offer", sdp: "old", gen: 1, fresh: true }), false);
  await session.acceptSignal({ kind: "offer", sdp: "old", gen: 1, fresh: true });
  assert.equal(first.closed, 0);
  assert.equal(second.closed, 0);
  assert.deepEqual(first.described, [{ type: "offer", sdp: "two" }]);
  assert.equal(sent.filter((item) => (item as { kind?: string }).kind === "answer").length, 1);
});

test("the host restarts ice on the same peer and replaces it only when fresh", async () => {
  const first = stubPeer();
  let channels = 0;
  first.createDataChannel = () => {
    channels += 1;
    return { readyState: "connecting", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
  };
  const second = stubPeer();
  let replaced = 0;
  second.createDataChannel = () => {
    replaced += 1;
    return { readyState: "connecting", send() {}, close() {}, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null };
  };
  const peers = [first, second];
  const sent: unknown[] = [];
  const session = await connectSession({
    role: "host",
    createPeer: () => peers.shift() ?? second,
    sendSignal: (payload) => sent.push(payload),
  });
  assert.equal(channels, 1);
  await session.renegotiate(false);
  assert.equal(channels, 1);
  assert.equal(first.closed, 0);
  assert.deepEqual(first.offered.at(-1), { iceRestart: true });
  assert.equal((sent.at(-1) as { fresh?: boolean }).fresh, false);
  await session.renegotiate(true);
  assert.equal(first.closed, 1);
  assert.equal(replaced, 1);
  assert.equal(second.offered.length, 1);
  assert.equal((sent.at(-1) as { fresh?: boolean }).fresh, true);
});

test("a host offer waits for an open socket and a guest candidate does not wait for an offer", async () => {
  let open = false;
  const held: unknown[] = [];
  const host = stubPeer();
  await connectSession({
    role: "host",
    createPeer: () => host,
    isSocketOpen: () => open,
    sendSignal: (payload) => held.push(payload),
  }).then((session) => {
    assert.deepEqual(held, []);
    open = true;
    session.flush();
  });
  assert.equal((held[0] as { kind?: string }).kind, "offer");

  const sent: unknown[] = [];
  const guest = stubPeer();
  await connectSession({
    role: "guest",
    createPeer: () => guest,
    sendSignal: (payload) => sent.push(payload),
  });
  guest.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "g", sdpMid: "0", sdpMLineIndex: 0 }) } });
  assert.deepEqual(sent, [{ kind: "candidate", init: { candidate: "g", sdpMid: "0", sdpMLineIndex: 0 }, gen: 1 }]);
});

test("ICE failure is reported as a failed connection right away", async () => {
  const states: (string | undefined)[] = [];
  const peer: PeerLike = {
    config: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    connectionState: "connecting",
    iceConnectionState: "checking",
    createDataChannel() {
      return {
        readyState: "connecting",
        send() {},
        close() {},
        binaryType: "arraybuffer",
        onopen: null,
        onmessage: null,
        onclose: null,
      };
    },
    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    },
    async createAnswer() {
      return { type: "answer", sdp: "answer-sdp" };
    },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    async addIceCandidate() {},
    close() {},
  };
  await connectSession({
    role: "host",
    createPeer: () => peer,
    sendSignal: () => undefined,
    onConnectionState: (state) => states.push(state),
  });
  peer.iceConnectionState = "failed";
  peer.oniceconnectionstatechange?.();
  assert.deepEqual(states, ["failed"]);
});
