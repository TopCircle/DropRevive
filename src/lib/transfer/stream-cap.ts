import {
  CHUNK_BYTES,
  CHUNK_BYTES_V2,
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  V2_MAX_BATCH_BYTES,
  V2_MAX_FILE_BYTES,
  V2_MAX_FILE_IOS_BYTES,
  V2_MAX_FILE_SAFARI_BYTES,
  V2_MAX_FILES,
} from "./limits.ts";

/** SDP capability line. Unknown attributes are ignored by old clients; we never send new JSON to them. */

export type StreamPlat = "ios" | "safari" | "other";

export const STREAM_CAP_NAME = "x-droprevive";

export function detectStreamPlat(ua: string): StreamPlat {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android|OPR|Firefox|FxiOS/i.test(ua)) return "safari";
  return "other";
}

export function streamCapLine(plat: StreamPlat): string {
  return `a=${STREAM_CAP_NAME}:stream-v2 ${plat}`;
}

/** Insert the capability at session level, only on a real SDP (starts with v=0). Test stubs are left alone. */
export function attachStreamCap(sdp: string, plat: StreamPlat): string {
  if (!sdp.startsWith("v=0") || hasStreamCap(sdp)) return sdp;
  const nl = sdp.includes("\r\n") ? "\r\n" : "\n";
  const head = sdp.startsWith("v=0\r\n") ? "v=0\r\n" : "v=0\n";
  return head + streamCapLine(plat) + nl + sdp.slice(head.length);
}

export function parseStreamCap(sdp: string): { v2: true; plat: StreamPlat } | null {
  const match = /(?:^|[\r\n])a=x-droprevive:stream-v2(?: (ios|safari|other))?(?:[\r\n]|$)/.exec(sdp);
  if (!match) return null;
  const plat = match[1];
  return { v2: true, plat: plat === "ios" || plat === "safari" ? plat : "other" };
}

export function hasStreamCap(sdp: string): boolean {
  return parseStreamCap(sdp) !== null;
}

export type TransferLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxBatchBytes: number;
  v2: boolean;
  chunkBytes: number;
};


export function platFileLimit(plat: StreamPlat): number {
  if (plat === "ios") return V2_MAX_FILE_IOS_BYTES;
  if (plat === "safari") return V2_MAX_FILE_SAFARI_BYTES;
  return V2_MAX_FILE_BYTES;
}

/** The tighter of the two peers. Either side on v1 keeps the original 32 / 64 MiB / 8-file caps. */
export function negotiatedLimits(local: StreamPlat, remote: { v2: boolean; plat?: StreamPlat } | null): TransferLimits {
  if (!remote?.v2) {
    return {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxBatchBytes: MAX_BATCH_BYTES,
      v2: false,
      chunkBytes: CHUNK_BYTES,
    };
  }
  const file = Math.min(platFileLimit(local), platFileLimit(remote.plat ?? "other"));
  return {
    maxFiles: V2_MAX_FILES,
    maxFileBytes: file,
    maxBatchBytes: Math.min(V2_MAX_BATCH_BYTES, file * V2_MAX_FILES),
    v2: true,
    chunkBytes: CHUNK_BYTES_V2,
  };
}
