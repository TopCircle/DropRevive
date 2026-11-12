import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_CHUNK_BYTES,
  MICROSOFT_CHUNK_BYTES,
  RetryableUploadError,
  UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_BASE_MS,
  isRetryableUploadStatus,
  monotonicProgress,
  nextByteFromGoogleRange,
  retryDelayMs,
  retryUploadRequest,
  startFromExpectedRanges,
} from "./upload-retry.ts";

describe("upload chunk sizes", () => {
  it("Google chunks are 8 MiB and a multiple of 256 KiB", () => {
    assert.equal(GOOGLE_CHUNK_BYTES, 8 * 1024 * 1024);
    assert.equal(GOOGLE_CHUNK_BYTES % (256 * 1024), 0);
  });

  it("OneDrive chunks are a multiple of 320 KiB near 8 MiB", () => {
    assert.equal(MICROSOFT_CHUNK_BYTES, 320 * 1024 * 26);
    assert.equal(MICROSOFT_CHUNK_BYTES % (320 * 1024), 0);
    assert.ok(MICROSOFT_CHUNK_BYTES > 8 * 1024 * 1024);
    assert.ok(MICROSOFT_CHUNK_BYTES < 10 * 1024 * 1024);
  });
});

describe("Google Range and Graph nextExpectedRanges", () => {
  it("parses the next byte from a 308 Range header", () => {
    assert.equal(nextByteFromGoogleRange("bytes=0-123"), 124);
    assert.equal(nextByteFromGoogleRange("bytes=0-0"), 1);
    assert.equal(nextByteFromGoogleRange("BYTES=1048576-8388607"), 8388608);
    assert.equal(nextByteFromGoogleRange(null), 0);
    assert.equal(nextByteFromGoogleRange("unrecognized"), 0);
  });

  it("parses Graph nextExpectedRanges", () => {
    assert.equal(startFromExpectedRanges(["1048576-"]), 1048576);
    assert.equal(startFromExpectedRanges(["1048576-2097151"]), 1048576);
    assert.equal(startFromExpectedRanges([]), null);
    assert.equal(startFromExpectedRanges(undefined), null);
    assert.equal(startFromExpectedRanges(["nope"]), null);
  });
});

describe("retryUploadRequest", () => {
  it("retries 5xx and 429 up to 3 attempts, with 300ms then 600ms backoff", async () => {
    const delays: number[] = [];
    let n = 0;
    const result = await retryUploadRequest(
      async () => {
        n += 1;
        return { status: n === 3 ? 200 : n === 1 ? 503 : 429, text: "" };
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(n, UPLOAD_ATTEMPTS);
    assert.deepEqual(delays, [UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_BASE_MS * 2]);
    assert.deepEqual(delays, [retryDelayMs(0), retryDelayMs(1)]);
  });

  it("retries a network error three times, then throws", async () => {
    const delays: number[] = [];
    let n = 0;
    await assert.rejects(
      retryUploadRequest(
        async () => {
          n += 1;
          throw new RetryableUploadError("cut");
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
      (error: unknown) => error instanceof RetryableUploadError && error.message === "cut",
    );
    assert.equal(n, 3);
    assert.deepEqual(delays, [300, 600]);
  });

  it("does not retry a 4xx response", async () => {
    let n = 0;
    const result = await retryUploadRequest(
      async () => {
        n += 1;
        return { status: 400, text: "bad" };
      },
      { sleep: async () => assert.fail("must not back off on 4xx") },
    );
    assert.equal(result.status, 400);
    assert.equal(n, 1);
  });

  it("does not retry a non-retryable Error", async () => {
    let n = 0;
    await assert.rejects(
      retryUploadRequest(
        async () => {
          n += 1;
          throw new Error("rejected");
        },
        { sleep: async () => assert.fail("must not back off") },
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "rejected" &&
        !(error instanceof RetryableUploadError),
    );
    assert.equal(n, 1);
  });

  it("treats TypeError as a retryable network failure", async () => {
    let n = 0;
    const result = await retryUploadRequest(
      async () => {
        n += 1;
        if (n < 2) throw new TypeError("Failed to fetch");
        return { status: 200, text: "ok" };
      },
      { sleep: async () => undefined },
    );
    assert.equal(result.status, 200);
    assert.equal(n, 2);
  });

  it("identifies retryable HTTP statuses", () => {
    assert.equal(isRetryableUploadStatus(0), true);
    assert.equal(isRetryableUploadStatus(429), true);
    assert.equal(isRetryableUploadStatus(500), true);
    assert.equal(isRetryableUploadStatus(503), true);
    assert.equal(isRetryableUploadStatus(400), false);
    assert.equal(isRetryableUploadStatus(401), false);
    assert.equal(isRetryableUploadStatus(404), false);
    assert.equal(isRetryableUploadStatus(416), false);
    assert.equal(isRetryableUploadStatus(200), false);
    assert.equal(isRetryableUploadStatus(308), false);
  });
});

describe("monotonicProgress", () => {
  it("never reports a lower ratio than one already reported", () => {
    const seen: number[] = [];
    const report = monotonicProgress((ratio) => seen.push(ratio));
    report(0.4);
    report(0);
    report(0.2);
    report(0.7);
    report(0.7);
    report(1.2);
    assert.deepEqual(seen, [0.4, 0.7, 1]);
  });
});
