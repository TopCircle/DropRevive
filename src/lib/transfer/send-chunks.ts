import { BUFFERED_HIGH, CHUNK_BYTES } from "./limits.ts";
import { encodeChunk, encodeChunkV2, encodeTextChunk } from "./protocol.ts";
import { StreamingSha256 } from "./sha256.ts";
import type { DataChannelLike } from "./session.ts";

type LiveChannel = DataChannelLike & {
  maxMessageSize?: number;
  bufferedAmount?: number;
  onbufferedamountlow: (() => void) | null;
};

function messageLimit(channel: DataChannelLike): number {
  const max = (channel as LiveChannel).maxMessageSize;
  return typeof max === "number" && max > 0 ? max : 16 * 1024;
}

export function waitBuffer(channel: DataChannelLike, ceiling: number): Promise<void> {
  const live = channel as LiveChannel;
  if ((live.bufferedAmount ?? 0) <= ceiling) return Promise.resolve();
  return new Promise((resolve) => {
    live.onbufferedamountlow = () => resolve();
  });
}

export function sendFrame(channel: DataChannelLike, frame: Uint8Array): void {
  const copy = new ArrayBuffer(frame.byteLength);
  new Uint8Array(copy).set(frame);
  channel.send(copy);
}

export type SlicedFile = {
  size: number;
  slice: (start: number, end: number) => { arrayBuffer: () => Promise<ArrayBuffer> };
};

/**
 * Send a file from `start` using File.slice, never reading the whole file into memory.
 * `v2` picks the v2 frame (8-byte offset, larger payload). The hasher is updated with each slice.
 */
export async function writeFileChunks(
  channel: DataChannelLike,
  id: string,
  file: SlicedFile,
  input: {
    v2: boolean;
    start?: number;
    chunkBytes: number;
    hasher?: StreamingSha256;
    onProgress: (sent: number) => void;
    isCancelled?: () => boolean;
  },
): Promise<void> {
  const start = input.start ?? 0;
  if (file.size <= start) return;
  const overhead = (input.v2 ? 10 : 6) + new TextEncoder().encode(id).byteLength;
  const size = Math.min(input.chunkBytes, messageLimit(channel) - overhead);
  if (size < 1) throw new Error("frame");
  for (let offset = start; offset < file.size; offset += size) {
    if (input.isCancelled?.()) return;
    await waitBuffer(channel, BUFFERED_HIGH);
    if (input.isCancelled?.()) return;
    const end = Math.min(file.size, offset + size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    input.hasher?.update(bytes);
    const frame = input.v2
      ? encodeChunkV2({ id, offset, bytes })
      : encodeChunk({ id, offset, bytes });
    if (frame.byteLength > messageLimit(channel)) throw new Error("frame");
    sendFrame(channel, frame);
    input.onProgress(end);
  }
}

/** v1 text (always small) still goes as 0xc2 frames. */
export async function writeTextChunks(
  channel: DataChannelLike,
  id: string,
  bytes: Uint8Array,
  onProgress: (sent: number) => void,
): Promise<void> {
  if (bytes.byteLength === 0) return;
  const overhead = 6 + new TextEncoder().encode(id).byteLength;
  const size = Math.min(CHUNK_BYTES, messageLimit(channel) - overhead);
  if (size < 1) throw new Error("frame");
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    await waitBuffer(channel, BUFFERED_HIGH);
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    const frame = encodeTextChunk({ id, offset, bytes: slice });
    if (frame.byteLength > messageLimit(channel)) throw new Error("frame");
    sendFrame(channel, frame);
    onProgress(Math.min(bytes.byteLength, offset + slice.byteLength));
  }
}

/** Hash a file by reading slices so a 1 GiB file never becomes one ArrayBuffer. */
export async function hashSlicedFile(file: SlicedFile, chunk = 1024 * 1024): Promise<string> {
  const hasher = new StreamingSha256();
  for (let offset = 0; offset < file.size; offset += chunk) {
    const end = Math.min(file.size, offset + chunk);
    hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
  }
  return hasher.hex();
}
