import { MAX_DEVICE_NAME, MAX_SESSION_MS, RECONNECT_GRACE_MS, ROOM_TTL_MS } from "./limits.ts";

export type RoomPhase = "open" | "paired" | "closed";

export type RoomRecord = {
  code: string;
  hostToken: string;
  guestToken: string | null;
  hostName: string;
  guestName: string | null;
  expiresAt: number;
  phase: RoomPhase;
  pairedAt: number | null;
  hardEndAt: number | null;
  absentHostSince: number | null;
  absentGuestSince: number | null;
};

export type RoomError = "full" | "expired" | "closed" | "bad-token";
export type RoomRole = "host" | "guest";
export type SocketCounts = { host: number; guest: number };
export type AlarmDecision =
  | { type: "expire"; reason: "invite" | "idle" | "hard" }
  | { type: "announce"; absent: RoomRole; until: number }
  | { type: "wait"; until: number };

function clipName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_DEVICE_NAME);
  return trimmed || "device";
}

function emptyClocks(): Pick<RoomRecord, "pairedAt" | "hardEndAt" | "absentHostSince" | "absentGuestSince"> {
  return { pairedAt: null, hardEndAt: null, absentHostSince: null, absentGuestSince: null };
}

export function createRoom(input: { code: string; hostToken: string; hostName: string; now: number }): RoomRecord {
  return {
    code: input.code,
    hostToken: input.hostToken,
    guestToken: null,
    hostName: clipName(input.hostName),
    guestName: null,
    expiresAt: input.now + ROOM_TTL_MS,
    phase: "open",
    ...emptyClocks(),
  };
}

export function joinGuest(
  room: RoomRecord,
  input: { guestToken: string; guestName: string; now: number },
): { room: RoomRecord } | { error: RoomError } {
  if (room.phase === "closed") return { error: "closed" };
  if (input.now >= room.expiresAt) return { error: "expired" };
  if (room.guestToken) return { error: "full" };
  const hardEndAt = input.now + MAX_SESSION_MS;
  return {
    room: {
      ...room,
      guestToken: input.guestToken,
      guestName: clipName(input.guestName),
      phase: "paired",
      pairedAt: input.now,
      hardEndAt,
      expiresAt: Math.min(input.now + ROOM_TTL_MS, hardEndAt),
    },
  };
}

export function admit(room: RoomRecord, token: string, now: number): { role: RoomRole } | { error: RoomError } {
  if (room.phase === "closed") return { error: "closed" };
  if (now >= room.expiresAt) return { error: "expired" };
  if (token === room.hostToken) return { role: "host" };
  if (room.guestToken && token === room.guestToken) return { role: "guest" };
  return { error: "bad-token" };
}

export function lease(room: RoomRecord, now: number): RoomRecord {
  if (room.pairedAt == null || room.hardEndAt == null) return room;
  if (now >= room.expiresAt || now >= room.hardEndAt) return room;
  return { ...room, expiresAt: Math.min(now + ROOM_TTL_MS, room.hardEndAt) };
}

export function markAbsent(room: RoomRecord, role: RoomRole, now: number): RoomRecord {
  if (role === "host") {
    if (room.absentHostSince != null) return room;
    return { ...room, absentHostSince: now };
  }
  if (room.absentGuestSince != null) return room;
  return { ...room, absentGuestSince: now };
}

export function markPresent(room: RoomRecord, role: RoomRole): RoomRecord {
  if (role === "host") return room.absentHostSince == null ? room : { ...room, absentHostSince: null };
  return room.absentGuestSince == null ? room : { ...room, absentGuestSince: null };
}

export function earliestAlarm(room: RoomRecord, _now: number): number {
  let until = room.expiresAt;
  for (const absent of [room.absentHostSince, room.absentGuestSince]) {
    if (absent != null) until = Math.min(until, absent + RECONNECT_GRACE_MS);
  }
  return until;
}

export function alarmDecision(room: RoomRecord, now: number, sockets: SocketCounts): AlarmDecision {
  if (room.hardEndAt != null && now >= room.hardEndAt) return { type: "expire", reason: "hard" };
  if (now >= room.expiresAt) return { type: "expire", reason: room.pairedAt == null ? "invite" : "idle" };
  if (room.absentHostSince != null && now >= room.absentHostSince + RECONNECT_GRACE_MS && sockets.guest > 0) {
    return { type: "announce", absent: "host", until: room.expiresAt };
  }
  if (room.absentGuestSince != null && now >= room.absentGuestSince + RECONNECT_GRACE_MS && sockets.host > 0) {
    return { type: "announce", absent: "guest", until: room.expiresAt };
  }
  const until = earliestAlarm(room, now);
  return { type: "wait", until: until > now ? until : room.expiresAt };
}

export function markClosed(room: RoomRecord): RoomRecord {
  return { ...room, phase: "closed" };
}
