import { isRoomCode } from "./code.ts";
import { CODE_ALPHABET, CODE_LENGTH, MAX_BATCH_BYTES, MAX_CONTROL_JSON, MAX_FILE_BYTES, MAX_FILES, MAX_SIGNAL_JSON, MAX_TEXT_BYTES } from "./limits.ts";

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
  | { t: "complete"; id: string };

export type ClientSignal =
  | { type: "hello"; token: string; deviceName: string }
  | { type: "lease"; token: string }
  | { type: "signal"; token: string; payload: SignalPayload }
  | { type: "cancel"; token: string };

export type ServerSignal =
  | { type: "joined"; role: "host" | "guest"; peerName: string | null }
  | { type: "peer"; deviceName: string }
  | { type: "signal"; payload: SignalPayload }
  | { type: "rejected"; reason: "bad-token" | "full" | "expired" | "closed" | "too-large" }
  | { type: "peer-left" }
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
  const message = parsed as { type?: string; token?: string; deviceName?: string; payload?: unknown };
  if (typeof message.token !== "string" || message.token.length < 16 || message.token.length > 80) return null;
  if (message.type === "cancel") return { type: "cancel", token: message.token };
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
  if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024) return null;
  return { id, offset, bytes };
}

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

export function decodeControl(raw: string): ControlMessage | null {
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
  if (message.t !== "manifest" || !exactKeys(message, ["t", "id", "textBytes", "files"])) return null;
  if (typeof message.id !== "string" || !isRoomCode(message.id)) return null;
  if (typeof message.textBytes !== "number" || !Number.isInteger(message.textBytes) || message.textBytes < 0 || message.textBytes > MAX_TEXT_BYTES) return null;
  if (!Array.isArray(message.files) || message.files.length > MAX_FILES) return null;
  const files: ManifestFile[] = [];
  for (const item of message.files) {
    if (!item || typeof item !== "object" || !exactKeys(item, ["id", "name", "size", "mime"])) return null;
    const file = item as ManifestFile;
    if (file.id.length !== CODE_LENGTH || [...file.id].some((char) => !CODE_ALPHABET.includes(char))) return null;
    if (typeof file.name !== "string" || file.name.length < 1 || file.name.length > 120) return null;
    if (typeof file.mime !== "string" || file.mime.length > 100) return null;
    if (typeof file.size !== "number" || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) return null;
    files.push({ id: file.id, name: file.name, size: file.size, mime: file.mime });
  }
  const batch = files.reduce((sum, file) => sum + file.size, message.textBytes);
  if (batch > MAX_BATCH_BYTES) return null;
  return { t: "manifest", id: message.id, textBytes: message.textBytes, files };
}
