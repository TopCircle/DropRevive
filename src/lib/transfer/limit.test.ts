import assert from "node:assert/strict";
import test from "node:test";
import { allowHit } from "./limit.ts";
import { CREATE_PER_WINDOW, LIMIT_WINDOW_MS } from "./limits.ts";

test("fifth create is allowed and the sixth waits for the next window", () => {
  let state: { windowStart: number; count: number } | null = null;
  const now = 1_000;
  for (let attempt = 0; attempt < CREATE_PER_WINDOW; attempt += 1) {
    const result = allowHit(state, now, CREATE_PER_WINDOW, LIMIT_WINDOW_MS);
    assert.equal(result.ok, true);
    state = result.next;
  }
  const blocked = allowHit(state, now + 10, CREATE_PER_WINDOW, LIMIT_WINDOW_MS);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.next.count, CREATE_PER_WINDOW);
  const reopened = allowHit(blocked.next, now + LIMIT_WINDOW_MS, CREATE_PER_WINDOW, LIMIT_WINDOW_MS);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.next.count, 1);
});
