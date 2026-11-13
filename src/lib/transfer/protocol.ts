import { isRoomCode } from "./code.ts";
import { CHUNK_BYTES, CHUNK_BYTES_V2, CODE_ALPHABET, CODE_LENGTH, MAX_BATCH_BYTES, MAX_CONTROL_JSON, MAX_FILE_BYTES, MAX_FILES, MAX_SIGNAL_JSON, MAX_TEXT_BYTES, V2_MAX_BATCH_BYTES, V2_MAX_FILE_BYTES, V2_MAX_FILES } from "./limits.ts";

export type IceInit = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};

export type SignalPayload =
  | { kind: "offer"; sdp: string; gen: number; fresh: boolean }
  | { kind: "answer"; sdp: string; gen: number }
  | { kind: "candidate"; init: IceInit; gen: number };

export type ManifestFile = { id: string; name: string; size: number; mime: string };

export type ControlMessage =
  | { t: "manifest"; id: string; textBytes: number; files: ManifestFile[] }
  | { t: "accept"; id: string }
  | { t: "reject"; id: string }
  | { t: "complete"; id: string }
  /** v2 only: never sent to a peer that did not advertise stream-v2 in SDP. */
  | { t: "resume"; id: string; files: { id: string; offset: number }[] }
  | { t: "digest"; id: string; files: { id: string; sha256: string }[] };

export type ControlLimits = {
  maxTextBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxBatchBytes: number;
  /** When false, resume and digest messages are rejected (old-client behaviour). */
  v2: boolean;
};

export const V1_CONTROL_LIMITS: ControlLimits = {
  maxTextBytes: MAX_TEXT_BYTES,
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxBatchBytes: MAX_BATCH_BYTES,
  v2: false,
};

export const V2_CONTROL_LIMITS: ControlLimits = {
  maxTextBytes: MAX_TEXT_BYTES,
  maxFiles: V2_MAX_FILES,
  maxFileBytes: V2_MAX_FILE_BYTES,
  maxBatchBytes: V2_MAX_BATCH_BYTES,
  v2: true,
};

export type ClientSignal =
  | { type: "hello"; token: string; deviceName: string }
  | { type: "lease"; token: string }
  | { type: "signal"; token: string; payload: SignalPayload }
  /** reason "direct-failed": the first direct connection never opened, so the other side can show why. */
  | { type: "cancel"; token: string; reason?: "direct-failed" };

export type ServerSignal =
  | { type: "joined"; role: "host" | "guest"; peerName: string | null }
  | { type: "peer"; deviceName: string }
  | { type: "signal"; payload: SignalPayload }
  | { type: "rejected"; reason: "bad-token" | "full" | "expired" | "closed" | "too-large" }
  /** bye: the other side chose to leave; gone: it did not come back within the reconnect window; direct-failed: the first direct connection never opened. */
  | { type: "peer-left"; reason?: "bye" | "gone" | "direct-failed" }
  | { type: "expired"; reason: "invite" | "idle" | "hard" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isIce(value: unknown): value is IceInit {
  if (!value || typeof value !== "object") return false;
  const init = value as IceInit;
  if (typeof init.candidate !== "string" || init.candidate.length < 1 || init.candidate.length > 2_000) return false;
  if (!(init.sdpMid === null || (typeof init.sdpMid === "string" && init.sdpMid.length <= 64))) return false;
  if (!(init.sdpMLineIndex === null || (Number.isInteger(init.sdpMLineIndex) && init.sdpMLineIndex >= 0 && init.sdpMLineIndex <= 16))) return false;
  if (init.usernameFragment !== undefined && init.usernameFragment !== null && (typeof init.usernameFragment !== "string" || init.usernameFragment.length > 256)) return false;
  return true;
}

function isGen(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 255;
}

function isSdp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 12_000;
}

function isPayload(value: unknown): value is SignalPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as { kind?: string; sdp?: string; init?: unknown; gen?: unknown; fresh?: unknown };
  if (!isGen(record.gen)) return false;
  if (record.kind === "offer") return isSdp(record.sdp) && typeof record.fresh === "boolean";
  if (record.kind === "answer") return isSdp(record.sdp);
  if (record.kind === "candidate") return isIce(record.init);
  return false;
}

export function encodeSignal(message: ClientSignal | ServerSignal): string {
  return JSON.stringify(message);
}

export function decodeSignal(raw: string): ClientSignal | null {
  if (raw.length > MAX_SIGNAL_JSON) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as { type?: string; token?: string; deviceName?: string; payload?: unknown; reason?: unknown };
  if (typeof message.token !== "string" || message.token.length < 16 || message.token.length > 80) return null;
  if (message.type === "cancel") {
    return message.reason === "direct-failed" ? { type: "cancel", token: message.token, reason: "direct-failed" } : { type: "cancel", token: message.token };
  }
  if (message.type === "lease") return { type: "lease", token: message.token };
  if (message.type === "hello" && typeof message.deviceName === "string") {
    return { type: "hello", token: message.token, deviceName: message.deviceName.slice(0, 40) };
  }
  if (message.type === "signal" && isPayload(message.payload)) {
    return { type: "signal", token: message.token, payload: message.payload };
  }
  return null;
}

export function encodeChunk(chunk: { id: string; offset: number; bytes: Uint8Array }): Uint8Array {
  const idBytes = encoder.encode(chunk.id);
  const frame = new Uint8Array(1 + 1 + idBytes.length + 4 + chunk.bytes.length);
  frame[0] = 0xc1;
  frame[1] = idBytes.length;
  frame.set(idBytes, 2);
  new DataView(frame.buffer).setUint32(2 + idBytes.length, chunk.offset);
  frame.set(chunk.bytes, 6 + idBytes.length);
  return frame;
}

export function encodeTextChunk(chunk: { id: string; offset: number; bytes: Uint8Array }): Uint8Array {
  const frame = encodeChunk(chunk);
  frame[0] = 0xc2;
  return frame;
}

export function decodeChunk(frame: Uint8Array): { id: string; offset: number; bytes: Uint8Array } | null {
  return decodeFrame(frame, 0xc1);
}

export function decodeTextChunk(frame: Uint8Array): { id: string; offset: number; bytes: Uint8Array } | null {
  return decodeFrame(frame, 0xc2);
}

function decodeFrame(frame: Uint8Array, magic: number): { id: string; offset: number; bytes: Uint8Array } | null {
  if (frame.byteLength < 7 || frame[0] !== magic) return null;
  const idLength = frame[1]!;
  if (idLength < 1 || idLength > 8 || frame.byteLength < 6 + idLength) return null;
  const id = decoder.decode(frame.subarray(2, 2 + idLength));
  if ([...id].some((char) => !CODE_ALPHABET.includes(char))) return null;
  const offset = new DataView(frame.buffer, frame.byteOffset + 2 + idLength, 4).getUint32(0);
  const bytes = frame.subarray(6 + idLength);
  if (bytes.byteLength < 1 || bytes.byteLength > CHUNK_BYTES) return null;
  return { id, offset, bytes };
}

const MAGIC_FILE_V2 = 0xc3;

function setUint64(view: DataView, at: number, value: number): void {
  view.setUint32(at, Math.floor(value / 0x1_0000_0000));
  view.setUint32(at + 4, value >>> 0);
}

function getUint64(view: DataView, at: number): number {
  return view.getUint32(at) * 0x1_0000_0000 + view.getUint32(at + 4);
}

export function encodeChunkV2(chunk: { id: string; offset: number; bytes: Uint8Array }): Uint8Array {
  const idBytes = encoder.encode(chunk.id);
  const frame = new Uint8Array(1 + 1 + idBytes.length + 8 + chunk.bytes.length);
  frame[0] = MAGIC_FILE_V2;
  frame[1] = idBytes.length;
  frame.set(idBytes, 2);
  setUint64(new DataView(frame.buffer, frame.byteOffset, frame.byteLength), 2 + idBytes.length, chunk.offset);
  frame.set(chunk.bytes, 10 + idBytes.length);
  return frame;
}

export function decodeChunkV2(frame: Uint8Array): { id: string; offset: number; bytes: Uint8Array } | null {
  if (frame.byteLength < 11 || frame[0] !== MAGIC_FILE_V2) return null;
  const idLength = frame[1]!;
  if (idLength < 1 || idLength > 8 || frame.byteLength < 10 + idLength) return null;
  const id = decoder.decode(frame.subarray(2, 2 + idLength));
  if ([...id].some((char) => !CODE_ALPHABET.includes(char))) return null;
  const offset = getUint64(new DataView(frame.buffer, frame.byteOffset + 2 + idLength, 8), 0);
  if (!Number.isInteger(offset) || offset < 0) return null;
  const bytes = frame.subarray(10 + idLength);
  if (bytes.byteLength < 1 || bytes.byteLength > CHUNK_BYTES_V2) return null;
  return { id, offset, bytes };
}

export const FILE_MAGIC_V2 = MAGIC_FILE_V2;

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function decodeOffsetList(
  files: unknown,
  limits: ControlLimits,
  field: "offset" | "sha256",
): { id: string; offset: number }[] | { id: string; sha256: string }[] | null {
  if (!Array.isArray(files) || files.length > limits.maxFiles) return null;
  const out: { id: string; offset?: number; sha256?: string }[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") return null;
    if (field === "offset") {
      if (!exactKeys(item, ["id", "offset"])) return null;
      const row = item as { id: unknown; offset: unknown };
      if (typeof row.id !== "string" || row.id.length !== CODE_LENGTH || [...row.id].some((char) => !CODE_ALPHABET.includes(char))) return null;
      if (typeof row.offset !== "number" || !Number.isInteger(row.offset) || row.offset < 0 || row.offset > limits.maxFileBytes) return null;
      out.push({ id: row.id, offset: row.offset });
    } else {
      if (!exactKeys(item, ["id", "sha256"])) return null;
      const row = item as { id: unknown; sha256: unknown };
      if (typeof row.id !== "string" || row.id.length !== CODE_LENGTH || [...row.id].some((char) => !CODE_ALPHABET.includes(char))) return null;
      if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) return null;
      out.push({ id: row.id, sha256: row.sha256 });
    }
  }
  return out as { id: string; offset: number }[] & { id: string; sha256: string }[];
}

export function decodeControl(raw: string, limits: ControlLimits = V1_CONTROL_LIMITS): ControlMessage | null {
  if (encoder.encode(raw).byteLength > MAX_CONTROL_JSON) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as { t?: string; id?: unknown; textBytes?: unknown; files?: unknown };
  if (message.t === "accept" || message.t === "reject" || message.t === "complete") {
    if (!exactKeys(message, ["t", "id"]) || typeof message.id !== "string" || !isRoomCode(message.id)) return null;
    return { t: message.t, id: message.id };
  }
  if (message.t === "resume" || message.t === "digest") {
    if (!limits.v2) return null;
    if (!exactKeys(message, ["t", "id", "files"]) || typeof message.id !== "string" || !isRoomCode(message.id)) return null;
    if (message.t === "resume") {
      const files = decodeOffsetList(message.files, limits, "offset") as { id: string; offset: number }[] | null;
      if (!files) return null;
      return { t: "resume", id: message.id, files };
    }
    const files = decodeOffsetList(message.files, limits, "sha256") as { id: string; sha256: string }[] | null;
    if (!files) return null;
    return { t: "digest", id: message.id, files };
  }
  if (message.t !== "manifest" || !exactKeys(message, ["t", "id", "textBytes", "files"])) return null;
  if (typeof message.id !== "string" || !isRoomCode(message.id)) return null;
  if (typeof message.textBytes !== "number" || !Number.isInteger(message.textBytes) || message.textBytes < 0 || message.textBytes > limits.maxTextBytes) return null;
  if (!Array.isArray(message.files) || message.files.length > limits.maxFiles) return null;
  const files: ManifestFile[] = [];
  for (const item of message.files) {
    if (!item || typeof item !== "object" || !exactKeys(item, ["id", "name", "size", "mime"])) return null;
    const file = item as ManifestFile;
    if (file.id.length !== CODE_LENGTH || [...file.id].some((char) => !CODE_ALPHABET.includes(char))) return null;
    if (typeof file.name !== "string" || file.name.length < 1 || file.name.length > 120) return null;
    if (typeof file.mime !== "string" || file.mime.length > 100) return null;
    if (typeof file.size !== "number" || !Number.isInteger(file.size) || file.size < 0 || file.size > limits.maxFileBytes) return null;
    files.push({ id: file.id, name: file.name, size: file.size, mime: file.mime });
  }
  const batch = files.reduce((sum, file) => sum + file.size, message.textBytes);
  if (batch > limits.maxBatchBytes) return null;
  return { t: "manifest", id: message.id, textBytes: message.textBytes, files };
}
