import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SESSION_MS, RECONNECT_GRACE_MS, ROOM_TTL_MS } from "./limits.ts";
import { admit, alarmDecision, createRoom, earliestAlarm, joinGuest, lease, markAbsent, markClosed, markPresent } from "./room.ts";

const now = 1_000_000;
const host = "h".repeat(32);
const guest = "g".repeat(32);

function pairedAt(at: number) {
  const created = createRoom({ code: "ABCDEFGH", hostToken: host, hostName: "这台 Mac", now });
  const joined = joinGuest(created, { guestToken: guest, guestName: "iPhone", now: at });
  if (!("room" in joined)) throw new Error("join");
  return joined.room;
}

test("one guest can join until the room expires or closes", () => {
  const created = createRoom({ code: "ABCDEFGH", hostToken: host, hostName: "这台 Mac", now });
  assert.equal(created.expiresAt, now + ROOM_TTL_MS);
  assert.equal(created.pairedAt, null);
  assert.equal(created.hardEndAt, null);
  const joined = joinGuest(created, { guestToken: guest, guestName: "iPhone", now: now + 1000 });
  assert.equal("room" in joined, true);
  if (!("room" in joined)) return;
  assert.equal(joined.room.phase, "paired");
  assert.equal(joined.room.hostName, "这台 Mac");
  assert.equal(joined.room.pairedAt, now + 1000);
  assert.equal(joined.room.hardEndAt, now + 1000 + MAX_SESSION_MS);
  assert.equal(joined.room.expiresAt, now + 1000 + ROOM_TTL_MS);
  const second = joinGuest(joined.room, { guestToken: "x".repeat(32), guestName: "其他", now: now + 2000 });
  assert.deepEqual(second, { error: "full" });
  assert.deepEqual(admit(markClosed(joined.room), host, now + 3000), { error: "closed" });
  assert.deepEqual(admit(joined.room, "nope", now + 3000), { error: "bad-token" });
  assert.deepEqual(admit(created, created.hostToken, now + ROOM_TTL_MS), { error: "expired" });
});

test("lease extends a paired room only up to the hard end", () => {
  const created = createRoom({ code: "ABCDEFGH", hostToken: host, hostName: "Mac", now });
  assert.equal(lease(created, now + 5_000), created);
  const room = pairedAt(now + 1000);
  const renewed = lease(room, room.pairedAt! + 60_000);
  assert.equal(renewed.expiresAt, room.pairedAt! + 60_000 + ROOM_TTL_MS);
  const stillOpen = { ...room, expiresAt: room.hardEndAt! - 30_000 };
  const nearEnd = lease(stillOpen, room.hardEndAt! - 60_000);
  assert.equal(nearEnd.expiresAt, room.hardEndAt);
  assert.equal(lease(room, room.hardEndAt!), room);
  assert.equal(lease(room, room.expiresAt), room);
});

test("absence keeps the first timestamp and clears when the role returns", () => {
  const room = pairedAt(now + 1000);
  const absent = markAbsent(room, "host", now + 2000);
  const again = markAbsent(absent, "host", now + 3000);
  assert.equal(again.absentHostSince, now + 2000);
  assert.equal(markPresent(again, "host").absentHostSince, null);
});

test("alarm waits out the grace, then announces only when the other side still has a socket", () => {
  const room = markAbsent(pairedAt(now + 1000), "host", now + 2000);
  const early = alarmDecision(room, now + 2000 + RECONNECT_GRACE_MS - 1, { host: 0, guest: 1 });
  assert.deepEqual(early, { type: "wait", until: now + 2000 + RECONNECT_GRACE_MS });
  assert.equal(earliestAlarm(room, now + 2000), now + 2000 + RECONNECT_GRACE_MS);
  const due = alarmDecision(room, now + 2000 + RECONNECT_GRACE_MS, { host: 0, guest: 1 });
  assert.deepEqual(due, { type: "announce", absent: "host", until: room.expiresAt });
  const alone = alarmDecision(room, now + 2000 + RECONNECT_GRACE_MS, { host: 0, guest: 0 });
  assert.deepEqual(alone, { type: "wait", until: room.expiresAt });
  const back = markPresent(room, "host");
  assert.deepEqual(alarmDecision(back, now + 2000 + RECONNECT_GRACE_MS, { host: 1, guest: 1 }), {
    type: "wait",
    until: room.expiresAt,
  });
});

test("alarm expires on the hard cap, then idle, then an unpaired invite", () => {
  const room = pairedAt(now + 1000);
  const forced = { ...room, expiresAt: room.hardEndAt! + 1 };
  assert.deepEqual(alarmDecision(forced, forced.hardEndAt!, { host: 1, guest: 1 }), { type: "expire", reason: "hard" });
  assert.deepEqual(alarmDecision(room, room.expiresAt, { host: 1, guest: 1 }), { type: "expire", reason: "idle" });
  const created = createRoom({ code: "ABCDEFGH", hostToken: host, hostName: "Mac", now });
  assert.deepEqual(alarmDecision(created, created.expiresAt, { host: 1, guest: 0 }), { type: "expire", reason: "invite" });
});
