import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { RECONNECT_GRACE_MS, ROOM_TTL_MS } from "./limits.ts";
import { decideLinkFault } from "./recover.ts";
import { createRecovery } from "./recovery.ts";
import { alarmDecision, createRoom, joinGuest, markAbsent } from "./room.ts";

test("the reconnect window is 10 minutes", () => {
  assert.equal(RECONNECT_GRACE_MS, 10 * 60 * 1000);
});

test("recovery keeps trying for 10 minutes, then the link gives up", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let graced = 0;
    const recovery = createRecovery({
      graceMs: RECONNECT_GRACE_MS,
      settleMs: 5000,
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
      connectionState: () => "disconnected",
      onGrace: () => void (graced += 1),
      onSettle() {},
    });
    recovery.ensure(true);
    mock.timers.tick(RECONNECT_GRACE_MS - 1);
    assert.equal(graced, 0);
    assert.equal(recovery.graceExpired, false);
    mock.timers.tick(1);
    assert.equal(graced, 1);
    const decision = decideLinkFault({
      opened: true,
      recovering: recovery.recovering,
      graceExpired: recovery.graceExpired,
      channelOpen: false,
      preparedRestart: false,
      settleElapsed: false,
      fault: "ws-close",
    });
    assert.deepEqual(decision, { action: "give-up" });
  } finally {
    mock.timers.reset();
  }
});

test("a dropped peer keeps a paired room alive past idle expiry until the window ends", () => {
  const now = 1_000_000;
  const created = createRoom({ code: "QWERTYUP", hostToken: "h", hostName: "host", now });
  const joined = joinGuest(created, { guestToken: "g", guestName: "guest", now: now + 1000 });
  assert.ok("room" in joined);
  const paired = joined.room;
  // The host drops 9 minutes later: idle expiry alone would end the room a minute after that.
  const dropAt = now + 9 * 60 * 1000;
  const absent = markAbsent(paired, "host", dropAt);
  assert.ok(absent.expiresAt >= dropAt + RECONNECT_GRACE_MS);
  assert.equal(alarmDecision(absent, paired.expiresAt + 1, { host: 0, guest: 1 }).type, "wait");
  const due = alarmDecision(absent, dropAt + RECONNECT_GRACE_MS, { host: 0, guest: 1 });
  assert.equal(due.type, "announce");
  assert.ok(ROOM_TTL_MS > 0);
});
