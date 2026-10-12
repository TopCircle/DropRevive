import { generateCode, isRoomCode } from "../src/lib/transfer/code.ts";
import { MAX_DEVICE_NAME, MAX_HTTP_BODY } from "../src/lib/transfer/limits.ts";
import {
  isAllowedOrigin,
  malformedWarning,
  parseAllowedOrigins,
  refusalReason,
  warnOnce,
} from "../src/lib/allowed-origins.ts";

type RoomStub = {
  create(input: { code: string; hostToken: string; hostName: string }): Promise<unknown>;
  join(input: { guestToken: string; guestName: string }): Promise<Record<string, unknown>>;
  fetch(request: Request): Promise<Response>;
};

export type TransferHttpEnv = {
  TRANSFER_ROOM: { getByName(name: string): RoomStub };
  TRANSFER_GATE: { getByName(name: string): { allow(kind: string, ip: string): Promise<boolean> } };
  /** Comma-separated full origins; same Worker secret as the drive-auth broker. Optional: unset = same-origin only. */
  ALLOWED_ORIGINS?: string;
};

function token(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function originAllowed(request: Request, env: TransferHttpEnv): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Pairing must be same-host as the page that opened the WebSocket / POST.
  const site = new URL(request.url);
  if (parsed.host !== site.host) return false;
  // ALLOWED_ORIGINS unset/none: same-origin only; set: the strict list (see allowed-origins.ts).
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const malformed = malformedWarning(allowed);
  if (malformed) warnOnce("transfer", malformed);
  if (!isAllowedOrigin(parsed.origin, allowed, site.origin)) {
    warnOnce("transfer", refusalReason(parsed.origin, allowed));
    return false;
  }
  return true;
}

/** A declared Content-Length over the cap: reject before touching the body or the rate gate. */
function declaresTooLarge(request: Request): boolean {
  const claimed = Number(request.headers.get("content-length") || "0");
  return Number.isFinite(claimed) && claimed > MAX_HTTP_BODY;
}

/**
 * Reads at most MAX_HTTP_BODY bytes. Counts bytes as they stream in and cancels the
 * body as soon as the count passes the cap, so a chunked or under-declared body is
 * never buffered whole. A missing body or JSON that does not parse becomes null,
 * which the field validation then rejects as a bad request.
 */
async function readBody(request: Request): Promise<unknown | "too-large" | null> {
  if (declaresTooLarge(request)) return "too-large";
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTTP_BODY) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * The room clips names to MAX_DEVICE_NAME and our client never sends more than that.
 * Anything far longer is not a real device name, so reject it rather than clip it.
 */
const MAX_RAW_DEVICE_NAME = MAX_DEVICE_NAME * 4;

type Invalid = { invalid: "bad-request" | "bad-code" };

function badRequest(error: Invalid["invalid"]): Response {
  return Response.json({ error }, { status: 400 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `deviceName` is optional. Absent, empty or whitespace-only falls back to "device",
 * as before. Present but not a string, or absurdly long, is a bad request.
 */
function parseDeviceName(body: Record<string, unknown>): string | Invalid {
  const raw = body.deviceName;
  if (raw === undefined) return "device";
  if (typeof raw !== "string" || raw.length > MAX_RAW_DEVICE_NAME) return { invalid: "bad-request" };
  return raw.trim() || "device";
}

/** Body for POST /api/transfer: a JSON object, optional deviceName. Extra keys are ignored. */
export function parseCreateBody(body: unknown): { deviceName: string } | Invalid {
  if (!isPlainObject(body)) return { invalid: "bad-request" };
  const deviceName = parseDeviceName(body);
  if (typeof deviceName !== "string") return deviceName;
  return { deviceName };
}

/** Body for POST /api/transfer/join: a JSON object, a room code, optional deviceName. Extra keys are ignored. */
export function parseJoinBody(body: unknown): { code: string; deviceName: string } | Invalid {
  if (!isPlainObject(body)) return { invalid: "bad-request" };
  const raw = body.code === undefined ? "" : body.code;
  if (typeof raw !== "string") return { invalid: "bad-code" };
  const code = raw.toUpperCase();
  if (!isRoomCode(code)) return { invalid: "bad-code" };
  const deviceName = parseDeviceName(body);
  if (typeof deviceName !== "string") return deviceName;
  return { code, deviceName };
}

export async function handleTransferRequest(request: Request, env: TransferHttpEnv | null): Promise<Response> {
  const url = new URL(request.url);
  if (!env?.TRANSFER_ROOM || !env.TRANSFER_GATE) return Response.json({ error: "no-binding" }, { status: 503 });
  if (!originAllowed(request, env)) return new Response("origin", { status: 403 });
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const gate = env.TRANSFER_GATE.getByName("gate");

  if (request.method === "POST" && url.pathname === "/api/transfer") {
    // Cheap header check, then the rate gate, then a bounded read.
    if (declaresTooLarge(request)) return Response.json({ error: "too-large" }, { status: 413 });
    if (!(await gate.allow("create", ip))) return Response.json({ error: "rate" }, { status: 429 });
    const body = await readBody(request);
    if (body === "too-large") return Response.json({ error: "too-large" }, { status: 413 });
    const parsed = parseCreateBody(body);
    if ("invalid" in parsed) return badRequest(parsed.invalid);
    const { deviceName } = parsed;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = generateCode(() => crypto.getRandomValues(new Uint8Array(8)));
      try {
        const created = await env.TRANSFER_ROOM.getByName(code).create({ code, hostToken: token(), hostName: deviceName });
        return Response.json(created);
      } catch (error) {
        if (error instanceof Error && error.message === "room-exists") continue;
        throw error;
      }
    }
    return Response.json({ error: "busy" }, { status: 503 });
  }

  if (request.method === "POST" && url.pathname === "/api/transfer/join") {
    if (declaresTooLarge(request)) return Response.json({ error: "too-large" }, { status: 413 });
    if (!(await gate.allow("join", ip))) return Response.json({ error: "rate" }, { status: 429 });
    const body = await readBody(request);
    if (body === "too-large") return Response.json({ error: "too-large" }, { status: 413 });
    const parsed = parseJoinBody(body);
    if ("invalid" in parsed) return badRequest(parsed.invalid);
    const { code, deviceName } = parsed;
    try {
      const joined = await env.TRANSFER_ROOM.getByName(code).join({
        guestToken: token(),
        guestName: deviceName,
      });
      return Response.json({ code, ...joined });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "missing";
      const status = reason === "full" ? 409 : reason === "expired" || reason === "closed" ? 410 : 404;
      return Response.json({ error: reason }, { status });
    }
  }

  if (url.pathname === "/api/transfer/ws") {
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!isRoomCode(code)) return new Response("bad-code", { status: 400 });
    if (!(await gate.allow("join", ip))) return Response.json({ error: "rate" }, { status: 429 });
    return env.TRANSFER_ROOM.getByName(code).fetch(request);
  }

  return new Response("not found", { status: 404 });
}
