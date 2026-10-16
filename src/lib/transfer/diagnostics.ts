/**
 * Hidden P2P diagnostics, on with ?debug=1 (kept for the tab in sessionStorage, off with ?debug=0).
 * Every hook returns at once when it is off, so normal use pays nothing.
 */
import { ICE_SERVERS } from "./ice.ts";
import type { SignalPayload } from "./protocol.ts";

const KEY = "drop.debug";
const STATS_AFTER_MS = 20_000;
const PROBE_MS = 5_000;

function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  const flag = new URLSearchParams(window.location.search).get("debug");
  try {
    if (flag === "1") sessionStorage.setItem(KEY, "1");
    if (flag === "0") sessionStorage.removeItem(KEY);
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return flag === "1";
  }
}

/** Read once at load, before in-app navigation can drop the query. */
export const DEBUG = readFlag();

let lines: string[] = [];
const listeners = new Set<() => void>();

export function debugLines(): string[] {
  return lines;
}

export function subscribeDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export function dlog(text: string): void {
  if (!DEBUG) return;
  lines = [...lines, `${stamp()} ${text}`];
  for (const listener of listeners) listener();
}

export type Candidate = { type: string; protocol: string; address: string; port: number; relatedPort: number | null };

/** The fields of an ICE candidate line ("candidate:… 1 udp 2122 203.0.113.7 51234 typ srflx raddr … rport 51234"). */
export function parseCandidate(line: string): Candidate | null {
  const parts = line.replace(/^a=/, "").trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== "typ") return null;
  const rport = parts.indexOf("rport");
  return {
    type: parts[7],
    protocol: parts[2].toLowerCase(),
    address: parts[4],
    port: Number(parts[5]),
    relatedPort: rport > 0 ? Number(parts[rport + 1]) : null,
  };
}

function describe(candidate: Candidate): string {
  const base = candidate.relatedPort ? ` base:${candidate.relatedPort}` : "";
  return `${candidate.type} ${candidate.protocol} ${candidate.address}:${candidate.port}${base}`;
}

export type Mapping = { url: string; port: number; base: number | null };

/** Same local port seen at different public ports by different servers = per-destination mapping. */
export function natHint(mappings: Mapping[]): string {
  if (mappings.length === 0) return "no srflx: no STUN server answered";
  const ports = new Map<string, Set<number>>();
  for (const mapping of mappings) {
    const key = String(mapping.base ?? "?");
    ports.set(key, (ports.get(key) ?? new Set()).add(mapping.port));
  }
  for (const seen of ports.values()) {
    if (seen.size > 1) return "mapping varies per destination (likely symmetric NAT); STUN alone may not traverse";
  }
  return "consistent mapping (cone-like)";
}

type Watched = {
  addEventListener: RTCPeerConnection["addEventListener"];
  getStats?: () => Promise<RTCStatsReport>;
  iceGatheringState?: string;
  iceConnectionState?: string;
  connectionState?: string;
};

let probed = false;

type IceEvent = { candidate: (RTCIceCandidate & { url?: string }) | null; url?: string | null };

function candidateUrl(event: IceEvent): string {
  return event.candidate?.url || event.url || "";
}

/** Logs a session peer's candidates and state changes, then its candidate pairs on failure or after 20 s. */
export function watchPeer<T>(peer: T): T {
  if (!DEBUG) return peer;
  const pc = peer as unknown as Watched;
  const mappings: Mapping[] = [];
  dlog("peer created");
  if (!probed) {
    probed = true;
    void runNetworkTest();
  }
  pc.addEventListener("icecandidate", (event) => {
    const ice = event as unknown as IceEvent;
    if (!ice.candidate) {
      dlog("local gathering done");
      return;
    }
    const parsed = parseCandidate(ice.candidate.candidate);
    if (!parsed) return;
    const url = candidateUrl(ice);
    if (parsed.type === "srflx") mappings.push({ url, port: parsed.port, base: parsed.relatedPort });
    dlog(`local ${describe(parsed)}${url ? ` via ${url}` : ""}`);
  });
  pc.addEventListener("icegatheringstatechange", () => dlog(`iceGathering ${pc.iceGatheringState}`));
  pc.addEventListener("iceconnectionstatechange", () => dlog(`iceConnection ${pc.iceConnectionState}`));
  let dumped = false;
  const dump = (why: string) => {
    if (dumped) return;
    dumped = true;
    dlog(`nat hint (session): ${natHint(mappings)}`);
    void statsSummary(pc, why);
  };
  pc.addEventListener("connectionstatechange", () => {
    dlog(`connection ${pc.connectionState}`);
    if (pc.connectionState === "failed") dump("failed");
  });
  window.setTimeout(() => {
    if (pc.connectionState !== "closed") dump("20s");
  }, STATS_AFTER_MS);
  return peer;
}

async function statsSummary(pc: Watched, why: string): Promise<void> {
  if (!pc.getStats) return;
  try {
    const report = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    report.forEach((entry: Record<string, unknown>) => byId.set(String(entry.id), entry));
    let selected = "";
    for (const entry of byId.values()) {
      if (entry.type === "transport" && entry.selectedCandidatePairId) selected = String(entry.selectedCandidatePairId);
    }
    const pairs = [...byId.values()].filter((entry) => entry.type === "candidate-pair");
    dlog(`stats (${why}): ${pairs.length} candidate pairs${selected ? "" : ", none selected"}`);
    const side = (id: unknown) => {
      const item = byId.get(String(id));
      return item ? `${item.candidateType} ${item.protocol} ${item.address ?? "?"}:${item.port}` : "?";
    };
    for (const pair of pairs) {
      const mark = pair.id === selected ? "* " : "  ";
      dlog(`${mark}${pair.state}${pair.nominated ? " nominated" : ""} ${side(pair.localCandidateId)} -> ${side(pair.remoteCandidateId)} req:${pair.requestsSent ?? 0} resp:${pair.responsesReceived ?? 0}`);
    }
  } catch (error) {
    dlog(`stats failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Signaling: what went over the room socket, and what came back. */
export function logSignal(direction: "sent" | "recv", payload: SignalPayload): void {
  if (!DEBUG) return;
  if (payload.kind !== "candidate") {
    dlog(`${direction} ${payload.kind} gen:${payload.gen}`);
    return;
  }
  const parsed = parseCandidate(payload.init.candidate);
  if (direction === "recv") dlog(`remote ${parsed ? describe(parsed) : payload.init.candidate}`);
}

/** One throwaway connection per STUN server, then one with all of them for the NAT hint. */
export async function runNetworkTest(): Promise<void> {
  if (!DEBUG) return;
  dlog(`network test: ${ICE_SERVERS.length} STUN servers, ${PROBE_MS / 1000}s each`);
  const results = await Promise.all(ICE_SERVERS.map((server) => probe([server])));
  results.forEach((mappings, index) => {
    const url = String(ICE_SERVERS[index].urls);
    const first = mappings[0];
    dlog(first ? `probe ${url}: ok ${first.address}:${first.port}` : `probe ${url}: timeout`);
  });
  const combined = await probe(ICE_SERVERS);
  for (const mapping of combined) dlog(`all servers: srflx ${mapping.address}:${mapping.port} base:${mapping.base ?? "?"}${mapping.url ? ` via ${mapping.url}` : ""}`);
  dlog(`nat hint: ${natHint(combined)}`);
}

async function probe(iceServers: RTCIceServer[]): Promise<Array<Mapping & { address: string }>> {
  const found: Array<Mapping & { address: string }> = [];
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({ iceServers });
    const live = pc;
    const done = new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, PROBE_MS);
      live.addEventListener("icecandidate", (event) => {
        const ice = event as unknown as IceEvent;
        if (!ice.candidate) {
          window.clearTimeout(timer);
          resolve();
          return;
        }
        const parsed = parseCandidate(ice.candidate.candidate);
        if (parsed?.type === "srflx") found.push({ url: candidateUrl(ice), address: parsed.address, port: parsed.port, base: parsed.relatedPort });
      });
    });
    live.createDataChannel("probe");
    await live.setLocalDescription(await live.createOffer());
    await done;
  } catch (error) {
    dlog(`probe error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pc?.close();
  }
  return found;
}
