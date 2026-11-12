/** Max attempts for a single upload request (initial try plus two retries). */
export const UPLOAD_ATTEMPTS = 3;
/** First backoff after a retryable failure; doubles on each later failure. */
export const UPLOAD_RETRY_BASE_MS = 300;
export const UPLOAD_TIMEOUT_MS = 180_000;
/** Abort a request that has not reported any further progress for this long. */
export const UPLOAD_STALL_MS = 30_000;

/** Google Drive resumable chunks must be multiples of 256 KiB except the last. 8 MiB = 32 × 256 KiB. */
export const GOOGLE_CHUNK_BYTES = 8 * 1024 * 1024;
/** Graph fragments must be multiples of 320 KiB and under 60 MiB. 26 × 320 KiB ≈ 8.1 MiB. */
export const MICROSOFT_CHUNK_BYTES = 320 * 1024 * 26;

/** Network, timeout, or stall — safe to retry. Distinct from a user abort or a 4xx CloudError. */
export class RetryableUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableUploadError";
  }
}

export function isRetryableUploadStatus(status: number): boolean {
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableUploadFailure(error: unknown): boolean {
  return error instanceof RetryableUploadError || error instanceof TypeError;
}

export function retryDelayMs(failureIndex: number, base = UPLOAD_RETRY_BASE_MS): number {
  return base * 2 ** failureIndex;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type XhrSendResult = {
  status: number;
  text: string;
  header: (name: string) => string | null;
};

export type XhrSendFn = (input: {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: XMLHttpRequestBodyInit | null;
  onProgress?: (ratio: number) => void;
  timeoutMs?: number;
  stallMs?: number;
}) => Promise<XhrSendResult>;

export type DriveUploadIo = {
  xhrSend?: XhrSendFn;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Run `run` up to `attempts` times. Retries network failures, 5xx and 429, with
 * exponential backoff. 4xx (including 401) is returned to the caller as-is.
 */
export async function retryUploadRequest<T extends { status: number }>(
  run: () => Promise<T>,
  options?: { attempts?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const attempts = options?.attempts ?? UPLOAD_ATTEMPTS;
  const sleep = options?.sleep ?? wait;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await run();
      if (isRetryableUploadStatus(result.status) && i < attempts - 1) {
        await sleep(retryDelayMs(i));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadFailure(error) || i === attempts - 1) throw error;
      await sleep(retryDelayMs(i));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("upload retry exhausted");
}

/** Google 308 `Range: bytes=0-123` means the next byte to send is 124. Missing or invalid → 0. */
export function nextByteFromGoogleRange(header: string | null | undefined): number {
  if (!header) return 0;
  const match = /bytes\s*=\s*(\d+)\s*-\s*(\d+)/i.exec(header);
  if (!match) return 0;
  return Number(match[2]) + 1;
}

/** Graph `nextExpectedRanges` like `["1048576-"]` or `["1048576-2097151"]`. `null` if missing. */
export function startFromExpectedRanges(ranges: unknown): number | null {
  if (!Array.isArray(ranges) || ranges.length === 0 || typeof ranges[0] !== "string") return null;
  const match = /^(\d+)-(\d+)?$/.exec(ranges[0].trim());
  if (!match) return null;
  return Number(match[1]);
}

/** Progress callback that never reports a lower ratio than one already reported (retries must not jump back to 0). */
export function monotonicProgress(onProgress?: (ratio: number) => void): (ratio: number) => void {
  let max = 0;
  return (ratio: number) => {
    const next = Math.max(0, Math.min(1, ratio));
    if (next <= max) return;
    max = next;
    onProgress?.(max);
  };
}
