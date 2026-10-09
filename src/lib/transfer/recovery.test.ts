import assert from "node:assert/strict";
import test from "node:test";
import { createRecovery } from "./recovery.ts";

function clock() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    timers,
    setTimeout(fn: () => void) {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    fire() {
      const due = [...timers.entries()];
      for (const [id] of due) timers.delete(id);
      for (const [, fn] of due) fn();
    },
  };
}

test("a connected peer cancels the settle timer before it restarts ice", () => {
  const time = clock();
  const state = "disconnected";
  let settled = 0;
  const recovery = createRecovery({
    graceMs: 15_000,
    settleMs: 5_000,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    connectionState: () => state,
    onGrace() {},
    onSettle() {
      settled += 1;
    },
  });
  recovery.ensure(true);
  recovery.armSettle();
  assert.equal(recovery.recovering, true);
  recovery.connected();
  time.fire();
  assert.equal(settled, 0);
  assert.equal(recovery.settleElapsed, false);
});

test("the settle timer restarts ice only while the peer is still disconnected", () => {
  const time = clock();
  let state = "connected";
  let settled = 0;
  const recovery = createRecovery({
    graceMs: 15_000,
    settleMs: 5_000,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    connectionState: () => state,
    onGrace() {},
    onSettle() {
      settled += 1;
    },
  });
  recovery.armSettle();
  time.fire();
  assert.equal(settled, 0);
  state = "disconnected";
  recovery.armSettle();
  time.fire();
  assert.equal(settled, 1);
  assert.equal(recovery.settleElapsed, true);
});

test("reset clears an expired grace so the next disconnect can wait again", () => {
  const time = clock();
  let expired = 0;
  const recovery = createRecovery({
    graceMs: 15_000,
    settleMs: 5_000,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    connectionState: () => "disconnected",
    onGrace() {
      expired += 1;
    },
    onSettle() {},
  });
  recovery.ensure(true);
  time.fire();
  assert.equal(expired, 1);
  assert.equal(recovery.graceExpired, true);
  recovery.reset();
  assert.equal(recovery.recovering, false);
  assert.equal(recovery.graceExpired, false);
  assert.equal(recovery.settleElapsed, false);
  recovery.ensure(true);
  assert.equal(recovery.recovering, true);
  time.fire();
  assert.equal(expired, 2);
});
