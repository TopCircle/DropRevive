import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NETWORK_RETRY_MS, retryRead } from "./net-retry.ts";

function flaky(failures: number) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    attempt: async () => {
      calls += 1;
      if (calls <= failures) throw new TypeError("Failed to fetch");
      return "ok";
    },
  };
}

describe("retryRead (a request that got no response at all)", () => {
  it("retries a read once after a pause while online, and the blip never surfaces", async () => {
    const slept: number[] = [];
    const run = flaky(1);
    const out = await retryRead(run.attempt, { method: "GET", online: () => true, sleep: async (ms) => void slept.push(ms) });
    assert.equal(out, "ok");
    assert.equal(run.calls, 2);
    assert.deepEqual(slept, [NETWORK_RETRY_MS]);
  });

  it("a real outage fails the second time too", async () => {
    const run = flaky(5);
    await assert.rejects(retryRead(run.attempt, { online: () => true, sleep: async () => {} }), TypeError);
    assert.equal(run.calls, 2);
  });

  it("offline fails at once, without waiting", async () => {
    const run = flaky(5);
    let slept = false;
    await assert.rejects(retryRead(run.attempt, { method: "GET", online: () => false, sleep: async () => void (slept = true) }), TypeError);
    assert.equal(run.calls, 1);
    assert.equal(slept, false);
  });

  it("never repeats a write (POST / PATCH / PUT / DELETE)", async () => {
    for (const method of ["POST", "patch", "PUT", "DELETE"]) {
      const run = flaky(1);
      await assert.rejects(retryRead(run.attempt, { method, online: () => true, sleep: async () => {} }), TypeError);
      assert.equal(run.calls, 1, method);
    }
  });

  it("a response, even an error status, is returned as is (no retry)", async () => {
    let calls = 0;
    const out = await retryRead(async () => ({ status: 401, n: ++calls }), { online: () => true, sleep: async () => {} });
    assert.deepEqual(out, { status: 401, n: 1 });
  });
});
