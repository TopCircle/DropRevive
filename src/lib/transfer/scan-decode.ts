/**
 * Decoding side of the in-page QR scanner: which decoder to use, when to give up on the
 * native one, what a decoded string means, and how failures map to messages. Pure
 * logic with injected browser pieces, so it runs under node --test. The real BarcodeDetector,
 * the lazy jsQR import and the canvas are wired in transfer-panel.tsx.
 */
import { isRoomCode } from "./code.ts";

export type DecoderName = "native" | "jsqr";

export interface Decoder<S> {
  name: DecoderName;
  /** Raw QR strings found in the current frame (possibly none). */
  decode(source: S): Promise<string[]>;
}

export interface DecoderFactories<S> {
  /** Build the native decoder; reject when it is missing or unusable. */
  native?: () => Promise<Decoder<S>>;
  /** Load the jsQR fallback (lazy chunk); reject when it cannot be loaded. */
  jsqr: () => Promise<Decoder<S>>;
}

export interface ErrorInfo {
  name: string;
  message: string;
}

export function describeError(error: unknown): ErrorInfo {
  if (error instanceof Error) return { name: error.name || "Error", message: error.message };
  if (error && typeof error === "object") {
    const shaped = error as { name?: unknown; message?: unknown };
    return {
      name: typeof shaped.name === "string" ? shaped.name : "Error",
      message: typeof shaped.message === "string" ? shaped.message : String(error),
    };
  }
  return { name: "Error", message: String(error) };
}

/** Native detect() is abandoned after this many failures in a row, or this long with only errors. */
export const MAX_FAILURES_IN_ROW = 3;
export const MAX_ERROR_SPAN_MS = 3000;
/** A native decoder that never reads anything is swapped for jsQR after this long. */
export const NATIVE_QUIET_MS = 6000;
/** Tell the user how to help the camera after this long without a read. */
export const NOTHING_READ_MS = 10_000;

export interface Failures {
  inRow: number;
  since: number | null;
}

export function noFailures(): Failures {
  return { inRow: 0, since: null };
}

export function recordFailure(failures: Failures, now: number): Failures {
  return { inRow: failures.inRow + 1, since: failures.since ?? now };
}

export function shouldFallBack(failures: Failures, now: number): boolean {
  if (failures.inRow >= MAX_FAILURES_IN_ROW) return true;
  return failures.since !== null && now - failures.since >= MAX_ERROR_SPAN_MS;
}

export interface EngineInfo {
  decoder: DecoderName | null;
  frames: number;
  nativeError: ErrorInfo | null;
  lastError: ErrorInfo | null;
  switchedFromNative: "errors" | "quiet" | null;
}

export interface StepResult {
  raws: string[];
  error: ErrorInfo | null;
  /** True when no decoder is left to try. */
  dead: boolean;
}

export interface ScanEngine<S> {
  /** Pick a decoder; resolves to its name, or null when none is available. */
  start(): Promise<DecoderName | null>;
  step(source: S): Promise<StepResult>;
  info(): EngineInfo;
}

export function createScanEngine<S>(
  factories: DecoderFactories<S>,
  now: () => number = Date.now,
): ScanEngine<S> {
  let decoder: Decoder<S> | null = null;
  let failures = noFailures();
  let startedAt = 0;
  const state: EngineInfo = {
    decoder: null,
    frames: 0,
    nativeError: null,
    lastError: null,
    switchedFromNative: null,
  };

  async function loadJsqr(): Promise<boolean> {
    try {
      decoder = await factories.jsqr();
      state.decoder = "jsqr";
      failures = noFailures();
      return true;
    } catch (error) {
      decoder = null;
      state.decoder = null;
      state.lastError = describeError(error);
      return false;
    }
  }

  async function start(): Promise<DecoderName | null> {
    startedAt = now();
    if (factories.native) {
      try {
        decoder = await factories.native();
        state.decoder = "native";
        return "native";
      } catch (error) {
        state.nativeError = describeError(error);
      }
    }
    return (await loadJsqr()) ? "jsqr" : null;
  }

  async function step(source: S): Promise<StepResult> {
    if (!decoder) return { raws: [], error: state.lastError, dead: true };
    state.frames += 1;
    try {
      const raws = await decoder.decode(source);
      failures = noFailures();
      if (raws.length > 0) startedAt = now();
      if (
        decoder.name === "native" &&
        raws.length === 0 &&
        now() - startedAt >= NATIVE_QUIET_MS &&
        factories.native
      ) {
        // detect() resolves but never sees anything (some phones): trust the fallback instead.
        if (await loadJsqr()) state.switchedFromNative = "quiet";
      }
      return { raws, error: null, dead: false };
    } catch (error) {
      const info = describeError(error);
      state.lastError = info;
      failures = recordFailure(failures, now());
      if (decoder.name === "native" && shouldFallBack(failures, now())) {
        if (await loadJsqr()) {
          state.switchedFromNative = "errors";
          return { raws: [], error: info, dead: false };
        }
        return { raws: [], error: info, dead: true };
      }
      return { raws: [], error: info, dead: false };
    }
  }

  return { start, step, info: () => ({ ...state }) };
}

export type ScanOutcome =
  | { kind: "ok"; code: string }
  | { kind: "other-site"; host: string }
  | { kind: "bad-code" }
  | { kind: "unreadable" };

/** What a decoded string means for this page: a room of ours, another site's QR, or noise. */
export function judgeScan(raw: string, origin: string): ScanOutcome {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unreadable" };
  }
  if (url.origin !== origin) return { kind: "other-site", host: url.host || url.protocol };
  const code = (url.searchParams.get("transfer") || "").toUpperCase();
  return isRoomCode(code) ? { kind: "ok", code } : { kind: "bad-code" };
}

export type ScanErrorKey = "transfer.scanDenied" | "transfer.scanNoCamera" | "transfer.scanMissing";

/** Message for a getUserMedia (or other open) failure. */
export function scanErrorKey(error: unknown): ScanErrorKey {
  const name = describeError(error).name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return "transfer.scanDenied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "transfer.scanNoCamera";
  return "transfer.scanMissing";
}

export interface FrameLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
) => { data: string } | null;

/** jsQR over frames grabbed (and downscaled) by `grab`; null from grab means "no picture yet". */
export function createJsqrDecoder<S>(
  jsQR: JsQr,
  grab: (source: S) => FrameLike | null,
): Decoder<S> {
  return {
    name: "jsqr",
    async decode(source) {
      const frame = grab(source);
      if (!frame) return [];
      const found = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: "attemptBoth",
      });
      return found?.data ? [found.data] : [];
    },
  };
}

interface NativeDetector<S> {
  detect(source: S): Promise<Array<{ rawValue?: string }>>;
}

export function createNativeDecoder<S>(
  Ctor: (new (options?: { formats?: string[] }) => NativeDetector<S>) | undefined,
): Promise<Decoder<S>> {
  if (!Ctor) return Promise.reject(new Error("BarcodeDetector is not available"));
  try {
    const detector = new Ctor({ formats: ["qr_code"] });
    return Promise.resolve({
      name: "native",
      async decode(source) {
        const found = await detector.detect(source);
        return found.map((item) => item.rawValue || "").filter(Boolean);
      },
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Longest side jsQR sees; phones deliver 1280+ px, which only costs time. */
export const DECODE_WIDTH = 640;

export function decodeSize(
  videoWidth: number,
  videoHeight: number,
): { width: number; height: number } | null {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null;
  const scale = Math.min(1, DECODE_WIDTH / videoWidth);
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

export interface DebugSnapshot {
  hasNative: boolean;
  secure: boolean;
  formats: string;
  info: EngineInfo;
  lastRaw: string;
  lastOutcome: string;
  origin: string;
  video: { readyState: number; paused: boolean; width: number; height: number } | null;
  settings: unknown;
  capabilities: unknown;
  userAgent: string;
  brands: string;
}

function show(error: ErrorInfo | null): string {
  return error ? `${error.name}: ${error.message}` : "none";
}

/** Plain text for the ?scandebug=1 panel (also what the copy button puts on the clipboard). */
export function formatDebug(snapshot: DebugSnapshot): string {
  const video = snapshot.video;
  return [
    `BarcodeDetector in window: ${snapshot.hasNative}`,
    `isSecureContext: ${snapshot.secure}`,
    `supported formats: ${snapshot.formats}`,
    `native constructor: ${snapshot.info.nativeError ? `failed ${show(snapshot.info.nativeError)}` : snapshot.hasNative ? "ok" : "not tried"}`,
    `decoder: ${snapshot.info.decoder ?? "none"}${snapshot.info.switchedFromNative ? ` (switched from native: ${snapshot.info.switchedFromNative})` : ""}`,
    `frames: ${snapshot.info.frames}`,
    `last error: ${show(snapshot.info.lastError)}`,
    `last raw: ${snapshot.lastRaw || "none"}`,
    `accepted: ${snapshot.lastOutcome || "none"}`,
    `origin: ${snapshot.origin}`,
    video
      ? `video: readyState ${video.readyState}, paused ${video.paused}, ${video.width}x${video.height}`
      : "video: none",
    `settings: ${JSON.stringify(snapshot.settings ?? null)}`,
    `capabilities: ${JSON.stringify(snapshot.capabilities ?? null)}`,
    `ua: ${snapshot.userAgent}`,
    `brands: ${snapshot.brands}`,
  ].join("\n");
}

/** Draw the current video frame into `canvas`, downscaled, and read its pixels. */
export function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): FrameLike | null {
  const size = decodeSize(video.videoWidth, video.videoHeight);
  if (!size) return null;
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height);
}
