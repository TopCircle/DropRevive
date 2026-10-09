import assert from "node:assert/strict";
import test from "node:test";
import { onRemoteControl, type LiveControl } from "./control.ts";

const manifest = {
  t: "manifest" as const,
  id: "BBBBBBBB",
  textBytes: 3,
  files: [{ id: "ABCDEFGH", name: "a.txt", size: 3, mime: "text/plain" }],
};

test("either side can offer when the room is ready, then offer again after it finishes", () => {
  const first = onRemoteControl({ state: "ready", id: null }, manifest);
  assert.equal(first.action, "show");
  assert.deepEqual(first.next, { state: "incoming", id: "BBBBBBBB" });
  const after = onRemoteControl({ state: "ready", id: null }, { ...manifest, id: "CCCCCCCC" });
  assert.equal(after.action, "show");
  assert.equal(after.next.id, "CCCCCCCC");
});

test("the smaller offer id wins when both sides send at once", () => {
  const ours: LiveControl = { state: "outgoing", id: "MMMMMMMM" };
  const theirsWins = onRemoteControl(ours, { ...manifest, id: "AAAAAAAA" });
  assert.equal(theirsWins.action, "show");
  assert.deepEqual(theirsWins.next, { state: "incoming", id: "AAAAAAAA" });
  const weWin = onRemoteControl(ours, { ...manifest, id: "ZZZZZZZZ" });
  assert.equal(weWin.action, "reject-theirs");
  assert.deepEqual(weWin.next, ours);
});

test("accept and reject apply only to the offer we are waiting on", () => {
  const outgoing: LiveControl = { state: "outgoing", id: "BBBBBBBB" };
  assert.equal(onRemoteControl(outgoing, { t: "accept", id: "BBBBBBBB" }).action, "accepted");
  assert.deepEqual(onRemoteControl(outgoing, { t: "accept", id: "BBBBBBBB" }).next, { state: "sending", id: "BBBBBBBB" });
  assert.equal(onRemoteControl(outgoing, { t: "accept", id: "CCCCCCCC" }).action, "ignore");
  assert.equal(onRemoteControl(outgoing, { t: "reject", id: "BBBBBBBB" }).action, "declined");
  assert.deepEqual(onRemoteControl(outgoing, { t: "reject", id: "BBBBBBBB" }).next, { state: "ready", id: null });
  assert.equal(onRemoteControl({ state: "ready", id: null }, { t: "accept", id: "BBBBBBBB" }).action, "ignore");
});

test("a completed send returns to ready and a busy peer rejects a new offer", () => {
  const sending: LiveControl = { state: "sending", id: "BBBBBBBB" };
  const done = onRemoteControl(sending, { t: "complete", id: "BBBBBBBB" });
  assert.equal(done.action, "finished");
  assert.deepEqual(done.next, { state: "ready", id: null });
  assert.equal(onRemoteControl(sending, { t: "complete", id: "CCCCCCCC" }).action, "ignore");
  assert.equal(onRemoteControl({ state: "receiving", id: "BBBBBBBB" }, manifest).action, "reject-theirs");
  assert.equal(onRemoteControl({ state: "incoming", id: "AAAAAAAA" }, manifest).action, "reject-theirs");
});
