import assert from "node:assert/strict";
import test from "node:test";
import { decideLinkFault, type LinkFaultInput } from "./recover.ts";

function fault(overrides: Partial<LinkFaultInput> & Pick<LinkFaultInput, "fault">): LinkFaultInput {
  return {
    opened: false,
    recovering: false,
    graceExpired: false,
    channelOpen: false,
    preparedRestart: false,
    settleElapsed: false,
    ...overrides,
  };
}

test("a socket fault before the data channel opens reconnects instead of failing", () => {
  assert.deepEqual(decideLinkFault(fault({ fault: "ws-error" })), { action: "reconnect-socket" });
  assert.deepEqual(decideLinkFault(fault({ fault: "ws-close" })), { action: "reconnect-socket" });
  assert.deepEqual(decideLinkFault(fault({ fault: "pc-disconnected" })), { action: "ignore" });
  assert.deepEqual(decideLinkFault(fault({ fault: "dc-close" })), { action: "fail-initial" });
  assert.deepEqual(decideLinkFault(fault({ fault: "pc-failed" })), { action: "fail-initial" });
  assert.deepEqual(decideLinkFault(fault({ fault: "pc-closed" })), { action: "fail-initial" });
});

test("an open session reconnects signaling without ending while the channel stays open", () => {
  const live = { opened: true, channelOpen: true };
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "ws-close" })), { action: "reconnect-socket" });
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "ws-error" })), { action: "reconnect-socket" });
});

test("a disconnected open channel settles before one ice restart, and a dead channel replaces the peer", () => {
  const live = { opened: true, channelOpen: true };
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "pc-disconnected" })), { action: "arm-settle" });
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "pc-disconnected", settleElapsed: true })), {
    action: "renegotiate",
    fresh: false,
  });
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "dc-close" })), { action: "renegotiate", fresh: true });
  assert.deepEqual(decideLinkFault(fault({ ...live, channelOpen: false, fault: "pc-failed" })), {
    action: "renegotiate",
    fresh: true,
  });
  assert.deepEqual(decideLinkFault(fault({ ...live, channelOpen: false, fault: "pc-closed" })), {
    action: "renegotiate",
    fresh: true,
  });
});

test("a prepared restart ignores another channel fault until grace, then gives up", () => {
  const live = { opened: true, channelOpen: true, preparedRestart: true };
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "dc-close" })), { action: "ignore" });
  assert.deepEqual(decideLinkFault(fault({ ...live, fault: "pc-failed", graceExpired: true })), { action: "give-up" });
  assert.deepEqual(decideLinkFault(fault({ opened: true, channelOpen: true, fault: "ws-close", graceExpired: true })), {
    action: "give-up",
  });
});

test("a second socket close while recovering does not give up", () => {
  const during = { opened: true, channelOpen: true, recovering: true };
  assert.deepEqual(decideLinkFault(fault({ ...during, fault: "ws-error" })), { action: "reconnect-socket" });
  assert.deepEqual(decideLinkFault(fault({ ...during, fault: "ws-close" })), { action: "ignore" });
});
