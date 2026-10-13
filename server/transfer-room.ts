import { DurableObject } from "cloudflare:workers";
import { decodeSignal, encodeSignal, type ServerSignal } from "../src/lib/transfer/protocol.ts";
import {
  admit,
  alarmDecision,
  createRoom,
  earliestAlarm,
  joinGuest,
  lease,
  markAbsent,
  markPresent,
  type RoomRecord,
  type RoomRole,
} from "../src/lib/transfer/room.ts";

type Env = { TRANSFER_ROOM: DurableObjectNamespace };

const CLOCK_COLUMNS = ["paired_at", "hard_end_at", "absent_host", "absent_guest"] as const;

type RoomRow = {
  code: string;
  host_token: string;
  guest_token: string | null;
  host_name: string;
  guest_name: string | null;
  expires_at: number;
  phase: RoomRecord["phase"];
  paired_at: number | null;
  hard_end_at: number | null;
  absent_host: number | null;
  absent_guest: number | null;
};

function rowToRoom(row: RoomRow): RoomRecord {
  return {
    code: row.code,
    hostToken: row.host_token,
    guestToken: row.guest_token,
    hostName: row.host_name,
    guestName: row.guest_name,
    expiresAt: row.expires_at,
    phase: row.phase,
    pairedAt: row.paired_at,
    hardEndAt: row.hard_end_at,
    absentHostSince: row.absent_host,
    absentGuestSince: row.absent_guest,
  };
}

function isRole(value: string | undefined): value is RoomRole {
  return value === "host" || value === "guest";
}

export class TransferRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          code TEXT PRIMARY KEY,
          host_token TEXT NOT NULL,
          guest_token TEXT,
          host_name TEXT NOT NULL,
          guest_name TEXT,
          expires_at INTEGER NOT NULL,
          phase TEXT NOT NULL
        )
      `);
      const present = new Set(
        this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(room)").toArray().map((column) => column.name),
      );
      for (const column of CLOCK_COLUMNS) {
        if (!present.has(column)) this.ctx.storage.sql.exec(`ALTER TABLE room ADD COLUMN ${column} INTEGER`);
      }
    });
  }

  private load(): RoomRecord | null {
    const row = this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room LIMIT 1").toArray()[0];
    return row ? rowToRoom(row) : null;
  }

  private save(room: RoomRecord): void {
    this.ctx.storage.sql.exec("DELETE FROM room");
    this.ctx.storage.sql.exec(
      `INSERT INTO room (
         code, host_token, guest_token, host_name, guest_name, expires_at, phase,
         paired_at, hard_end_at, absent_host, absent_guest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      room.code,
      room.hostToken,
      room.guestToken,
      room.hostName,
      room.guestName,
      room.expiresAt,
      room.phase,
      room.pairedAt,
      room.hardEndAt,
      room.absentHostSince,
      room.absentGuestSince,
    );
  }

  private send(role: RoomRole, message: ServerSignal): void {
    const payload = encodeSignal(message);
    for (const socket of this.ctx.getWebSockets(role)) socket.send(payload);
  }

  private closeAll(message: ServerSignal): void {
    const payload = encodeSignal(message);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(payload);
      socket.close(1000, "closed");
    }
  }

  private async schedule(room: RoomRecord): Promise<void> {
    const now = Date.now();
    const until = earliestAlarm(room, now);
    if (until > now) {
      await this.ctx.storage.setAlarm(until);
      return;
    }
    await this.alarm();
  }

  async create(input: { code: string; hostToken: string; hostName: string }): Promise<{ code: string; hostToken: string; expiresAt: number }> {
    const existing = this.load();
    if (existing && existing.phase !== "closed" && Date.now() < existing.expiresAt) {
      throw new Error("room-exists");
    }
    if (existing) this.ctx.storage.sql.exec("DELETE FROM room");
    const room = createRoom({ ...input, now: Date.now() });
    this.save(room);
    await this.schedule(room);
    return { code: room.code, hostToken: room.hostToken, expiresAt: room.expiresAt };
  }

  async join(input: { guestToken: string; guestName: string }): Promise<{ guestToken: string; hostName: string; expiresAt: number }> {
    const current = this.load();
    if (!current) throw new Error("missing");
    const result = joinGuest(current, { ...input, now: Date.now() });
    if ("error" in result) throw new Error(result.error);
    this.save(result.room);
    await this.schedule(result.room);
    this.send("host", { type: "peer", deviceName: result.room.guestName || "device" });
    return { guestToken: input.guestToken, hostName: result.room.hostName, expiresAt: result.room.expiresAt };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const room = this.load();
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!room) return new Response("missing", { status: 404 });
    const admitted = admit(room, token, Date.now());
    if ("error" in admitted) return new Response(admitted.error, { status: 403 });
    const pair = new WebSocketPair();
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket, [admitted.role]);
    const present = markPresent(room, admitted.role);
    if (present !== room) this.save(present);
    for (const older of this.ctx.getWebSockets(admitted.role)) {
      if (older !== socket) older.close(1000, "replaced");
    }
    const saved = this.load();
    if (saved) await this.schedule(saved);
    const peerName = admitted.role === "host" ? room.guestName : room.hostName;
    socket.send(encodeSignal({ type: "joined", role: admitted.role, peerName }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      socket.close(1003, "text-only");
      return;
    }
    const decoded = decodeSignal(message);
    const room = this.load();
    if (!decoded || !room) {
      socket.close(1008, "bad-message");
      return;
    }
    const admitted = admit(room, decoded.token, Date.now());
    if ("error" in admitted) {
      socket.send(encodeSignal({ type: "rejected", reason: admitted.error === "bad-token" ? "bad-token" : admitted.error }));
      socket.close(1008, admitted.error);
      return;
    }
    if (decoded.type === "cancel") {
      this.ctx.storage.sql.exec("DELETE FROM room");
      await this.ctx.storage.deleteAlarm();
      this.closeAll({ type: "peer-left", reason: decoded.reason === "direct-failed" ? "direct-failed" : "bye" });
      return;
    }
    if (decoded.type === "hello") return;
    if (decoded.type === "lease") {
      const next = lease(room, Date.now());
      if (next !== room) {
        this.save(next);
        await this.schedule(next);
      }
      return;
    }
    const other: RoomRole = admitted.role === "host" ? "guest" : "host";
    this.send(other, { type: "signal", payload: decoded.payload });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const room = this.load();
    if (!room || room.phase === "closed") return;
    const role = this.ctx.getTags(ws)[0];
    if (!isRole(role)) return;
    const remaining = this.ctx.getWebSockets(role).filter((socket) => socket !== ws);
    if (remaining.length > 0) return;
    const absent = markAbsent(room, role, Date.now());
    if (absent !== room) this.save(absent);
    await this.schedule(absent);
  }

  async alarm(): Promise<void> {
    const room = this.load();
    if (!room) return;
    const now = Date.now();
    const decision = alarmDecision(room, now, {
      host: this.ctx.getWebSockets("host").length,
      guest: this.ctx.getWebSockets("guest").length,
    });
    if (decision.type === "expire") {
      this.ctx.storage.sql.exec("DELETE FROM room");
      await this.ctx.storage.deleteAlarm();
      this.closeAll({ type: "expired", reason: decision.reason });
      return;
    }
    if (decision.type === "announce") {
      const other: RoomRole = decision.absent === "host" ? "guest" : "host";
      this.send(other, { type: "peer-left", reason: "gone" });
      const next = markPresent(room, decision.absent);
      this.save(next);
      await this.ctx.storage.setAlarm(decision.until);
      return;
    }
    if (decision.until > now) await this.ctx.storage.setAlarm(decision.until);
  }
}
