/**
 * The LAN direct-transfer session, owned once per tab (not by the panel). The room, the WebRTC link
 * and the timeline live here, so switching between the inbox, drives, settings and the LAN page
 * keeps the session. It ends only on 断开 (disconnect), on pagehide, or when the server or the
 * peer ends it. The panel subscribes to `store` and calls the actions.
 *
 * Browser-only pieces (fetch, toasts, translations, object URLs, the WebRTC link) come in as deps,
 * so tests can drive the whole flow with fakes.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MessageKey } from "../i18n/types.ts";
import { FileAssembler } from "./assemble.ts";
import { generateCode, isRoomCode } from "./code.ts";
import { onRemoteControl } from "./control.ts";
import { ASSUMED_MAX_MESSAGE, BUFFERED_HIGH, CHUNK_BYTES, MAX_BATCH_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_TEXT_BYTES } from "./limits.ts";
import { freshLink, type LanHooks, type LanLink, type TransferLink, type TransferPhase } from "./link.ts";
import { takeRoomResponse } from "./panel-flow.ts";
import { decodeChunk, decodeControl, decodeTextChunk, encodeChunk, encodeTextChunk, type ManifestFile, type ServerSignal } from "./protocol.ts";
import type { DataChannelLike } from "./session.ts";
import { capTimeline, crossedUnsavedLimit, MAX_TIMELINE, unsavedSummary } from "./session-state.ts";
import { CONNECTION_NOTICES, openBatchFails, reduceTimeline, sessionVisible, type SessionEvent, type TimelineEntry } from "./timeline.ts";

export type ReceivedFile = { id: string; name: string; mime: string; bytes: Uint8Array };

export type LanState = {
  phase: TransferPhase;
  note: string;
  noteKey: string | null;
  entries: TimelineEntry[];
  code: string;
  peerName: string;
  texts: string[];
  saves: ReceivedFile[];
  savedIds: ReadonlySet<string>;
  previews: Readonly<Record<string, string>>;
  /** True while the LAN panel is on screen; toasts stand in for it otherwise. */
  panelOpen: boolean;
  /** Bumped when a toast asks the app to show the LAN page. */
  openRequests: number;
};

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type Notifier = {
  message(text: string, options?: { action?: { label: string; onClick: () => void } }): void;
  warning(text: string): void;
};

export type LanDeps = {
  t: Translate;
  deviceName(): string;
  notify: Notifier;
  fetch(input: string, init: RequestInit): Promise<Response>;
  createLink(linkRef: { current: TransferLink }, hooksRef: { current: LanHooks }): LanLink;
  formatBytes(bytes: number): string;
  createObjectURL(source: Blob): string;
  revokeObjectURL(url: string): void;
  random?(bytes: number): Uint8Array;
  now?(): number;
};

type LiveChannel = DataChannelLike & { maxMessageSize?: number; bufferedAmount?: number; onbufferedamountlow: (() => void) | null };

const THUMB_MAX = 10 * 1024 * 1024;

function messageLimit(channel: DataChannelLike): number {
  const max = (channel as LiveChannel).maxMessageSize;
  return typeof max === "number" && max > 0 ? max : ASSUMED_MAX_MESSAGE;
}

function waitBuffer(channel: DataChannelLike, ceiling: number): Promise<void> {
  const live = channel as LiveChannel;
  if ((live.bufferedAmount ?? 0) <= ceiling) return Promise.resolve();
  return new Promise((resolve) => {
    live.onbufferedamountlow = () => resolve();
  });
}

function sendFrame(channel: DataChannelLike, frame: Uint8Array): void {
  const copy = new ArrayBuffer(frame.byteLength);
  new Uint8Array(copy).set(frame);
  channel.send(copy);
}

async function writeChunks(channel: DataChannelLike, id: string, bytes: Uint8Array, text: boolean, onProgress: (sent: number) => void): Promise<void> {
  if (bytes.byteLength === 0) return;
  const overhead = 6 + new TextEncoder().encode(id).byteLength;
  const size = Math.min(CHUNK_BYTES, messageLimit(channel) - overhead);
  if (size < 1) throw new Error("frame");
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    await waitBuffer(channel, BUFFERED_HIGH);
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    const frame = text ? encodeTextChunk({ id, offset, bytes: slice }) : encodeChunk({ id, offset, bytes: slice });
    if (frame.byteLength > messageLimit(channel)) throw new Error("frame");
    sendFrame(channel, frame);
    onProgress(Math.min(bytes.byteLength, offset + slice.byteLength));
  }
}

export function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function initialLanState(): LanState {
  return {
    phase: "idle",
    note: "",
    noteKey: null,
    entries: [],
    code: "",
    peerName: "",
    texts: [],
    saves: [],
    savedIds: new Set(),
    previews: {},
    panelOpen: false,
    openRequests: 0,
  };
}

export type LanSession = ReturnType<typeof createLanSession>;

export function createLanSession(deps: LanDeps) {
  const store: StoreApi<LanState> = createStore<LanState>(() => initialLanState());
  const { t } = deps;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const linkRef = { current: freshLink() };
  const hooksRef: { current: LanHooks } = {
    current: {
      say: (phase, message) => show(phase, message ?? ""),
      note: (message) => showNote(message),
      text: (key) => t(key),
      onData: (data) => onChannel(data),
      onServer: (message) => onServer(message),
    },
  };
  let api = deps.createLink(linkRef, hooksRef);
  // Each room attempt gets a number; a reply that arrives after 断开 or a newer attempt is dropped.
  let attempt = 0;

  const get = () => store.getState();
  const set = (partial: Partial<LanState> | ((state: LanState) => Partial<LanState>)) => store.setState(partial);

  function newId(): string {
    return generateCode(() => random(8));
  }

  function holdsUnsaved(state: LanState): (fileId: string) => boolean {
    const held = new Set(state.saves.map((file) => file.id));
    return (id) => held.has(id) && !state.savedIds.has(id);
  }

  /** Every timeline change goes through here so the cap applies everywhere. */
  function timeline(update: (entries: TimelineEntry[]) => TimelineEntry[]) {
    set((state) => ({ entries: capTimeline(update(state.entries), MAX_TIMELINE, holdsUnsaved(state)) }));
  }

  function event(e: SessionEvent) {
    timeline((entries) => reduceTimeline(entries, e));
  }

  function noteKeyFor(message: string): string | null {
    if (!message) return null;
    for (const key of Object.keys(CONNECTION_NOTICES)) {
      if (t(key as MessageKey) === message) return key;
    }
    return null;
  }

  function revokeAll() {
    const previews = get().previews;
    for (const url of Object.values(previews)) deps.revokeObjectURL(url);
    set({ previews: {} });
  }

  function revokeOne(id: string) {
    const url = get().previews[id];
    if (!url) return;
    deps.revokeObjectURL(url);
    set((state) => {
      const next = { ...state.previews };
      delete next[id];
      return { previews: next };
    });
  }

  function applySurface(next: TransferPhase | null, message: string) {
    const key = noteKeyFor(message);
    const before = get().phase;
    const phaseForFail = next ?? before;
    set(next ? { phase: next, note: message, noteKey: key } : { note: message, noteKey: key });
    timeline((current) => {
      if (!sessionVisible(phaseForFail)) return current;
      let entries = next === "connected" ? reduceTimeline(current, { type: "clear-stale" }) : current;
      if (openBatchFails(key, phaseForFail)) entries = reduceTimeline(entries, { type: "fail-open" });
      const tone = key ? CONNECTION_NOTICES[key] : null;
      if (tone !== "reconnect") entries = reduceTimeline(entries, { type: "clear-reconnect" });
      if (tone && message) entries = reduceTimeline(entries, { type: "notice", at: now(), tone, text: message });
      return entries;
    });
    if (next === "failed" && before !== "failed") {
      // The session is over: thumbnails go; received files stay saveable until saved or removed.
      revokeAll();
      if (!get().panelOpen && message) deps.notify.warning(message);
    }
  }

  function show(next: TransferPhase, message = "") {
    if (!linkRef.current.alive) return;
    applySurface(next, message);
  }

  function showNote(message: string) {
    if (!linkRef.current.alive) return;
    applySurface(null, message);
  }

  function requestOpen() {
    set((state) => ({ openRequests: state.openRequests + 1 }));
  }

  function tellIfClosed(text: string) {
    if (get().panelOpen) return;
    deps.notify.message(text, { action: { label: t("transfer.openLan"), onClick: requestOpen } });
  }

  function markBatch(id: string | null, status: "waiting" | "confirm" | "transfer" | "done" | "declined" | "failed") {
    if (!id) return;
    event({ type: "status", id, status });
  }

  function publishProgress(done: number, total: number) {
    const id = linkRef.current.activeId;
    if (!id) return;
    event({ type: "progress", id, done, total });
  }

  function fail(message: string) {
    api.fail(message);
  }

  function sendControl(message: { t: "accept" | "reject" | "complete"; id: string } | { t: "manifest"; id: string; textBytes: number; files: ManifestFile[] }) {
    const channel = linkRef.current.channel;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(message));
    api.sendLease();
    api.syncLease();
  }

  function describe(text: string, files: File[]): { textBytes: number; files: ManifestFile[] } | "empty" | "too-big" {
    const textBytes = new TextEncoder().encode(text).byteLength;
    if (textBytes === 0 && files.length === 0) return "empty";
    if (textBytes > MAX_TEXT_BYTES || files.length > MAX_FILES) return "too-big";
    if (files.some((file) => !Number.isInteger(file.size) || file.size > MAX_FILE_BYTES)) return "too-big";
    const batch = files.reduce((sum, file) => sum + file.size, textBytes);
    if (batch > MAX_BATCH_BYTES) return "too-big";
    const used = new Set<string>();
    const listed = files.map((file) => {
      let id = newId();
      while (used.has(id)) id = newId();
      used.add(id);
      const name = (file.name || "file").slice(0, 120) || "file";
      const mime = (file.type || "application/octet-stream").slice(0, 100);
      return { id, name, size: file.size, mime };
    });
    return { textBytes, files: listed };
  }

  function rememberPreviews(items: { id: string; file?: File; mime?: string; bytes?: Uint8Array; size?: number }[]) {
    const next: Record<string, string> = {};
    for (const item of items) {
      const mime = item.file?.type || item.mime || "";
      const size = item.file?.size ?? item.size ?? 0;
      if (!mime.startsWith("image/") || size <= 0 || size > THUMB_MAX) continue;
      const source = item.file ?? (item.bytes ? new Blob([ownedBuffer(item.bytes)], { type: mime }) : null);
      if (!source) continue;
      next[item.id] = deps.createObjectURL(source);
    }
    if (Object.keys(next).length > 0) set((state) => ({ previews: { ...state.previews, ...next } }));
  }

  /** Offer the draft to the peer. True when it went out, so the caller can clear its draft. */
  function offer(text: string, files: File[]): boolean {
    const link = linkRef.current;
    const channel = link.channel;
    if (!channel || channel.readyState !== "open" || link.control !== "ready") return false;
    const described = describe(text, files);
    if (described === "empty") {
      show("connected", t("transfer.empty"));
      return false;
    }
    if (described === "too-big") {
      show("connected", t("transfer.tooBig"));
      return false;
    }
    const id = newId();
    link.activeId = id;
    link.control = "outgoing";
    link.snapshotText = text;
    link.snapshotFiles = files.slice();
    link.manifest = described;
    link.total = described.textBytes + described.files.reduce((sum, file) => sum + file.size, 0);
    event({
      type: "offer",
      id,
      at: now(),
      sender: deps.deviceName(),
      text,
      files: described.files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
      total: link.total,
    });
    sendControl({ t: "manifest", id, textBytes: described.textBytes, files: described.files });
    rememberPreviews(described.files.map((meta, index) => ({ id: meta.id, file: files[index] })));
    show("offering", t("transfer.waitingAccept"));
    return true;
  }

  async function pump(channel: DataChannelLike) {
    const link = linkRef.current;
    const manifest = link.manifest;
    if (!manifest) return;
    try {
      const encoded = new TextEncoder().encode(link.snapshotText);
      let sent = 0;
      if (encoded.byteLength > 0) {
        await writeChunks(channel, newId(), encoded, true, (at) => {
          sent = at;
          publishProgress(sent, link.total);
        });
      }
      for (let index = 0; index < manifest.files.length; index += 1) {
        const meta = manifest.files[index]!;
        const file = link.snapshotFiles[index];
        if (!file || meta.size === 0) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const base = sent;
        await writeChunks(channel, meta.id, bytes, false, (at) => {
          sent = base + at;
          publishProgress(sent, link.total);
        });
      }
      await waitBuffer(channel, 0);
    } catch {
      if (channel.readyState !== "open") api.applyFault("dc-close");
      else fail(t("transfer.failed"));
    }
  }

  function finishReceive() {
    const link = linkRef.current;
    if (link.control !== "receiving" || !link.manifest || !link.activeId) return;
    const filesComplete = link.manifest.files.every((file) => file.size === 0 || link.filesDone.has(file.id));
    if (!link.textDone || !filesComplete) return;
    const id = link.activeId;
    markBatch(id, "done");
    link.control = "ready";
    link.activeId = null;
    sendControl({ t: "complete", id });
    show("connected", t("transfer.received"));
  }

  function keepReceived(file: ReceivedFile) {
    const before = unsavedSummary(get().saves, get().savedIds).bytes;
    set((state) => ({ saves: [...state.saves, file] }));
    const after = unsavedSummary(get().saves, get().savedIds).bytes;
    if (crossedUnsavedLimit(before, after)) deps.notify.warning(t("transfer.unsavedLarge", { size: deps.formatBytes(after) }));
    tellIfClosed(t("transfer.toastReceived", { name: file.name }));
  }

  function onChannel(data: string | ArrayBuffer) {
    const link = linkRef.current;
    if (!link.alive || link.finished) return;
    if (typeof data === "string") {
      const control = decodeControl(data);
      if (!control) {
        fail(data.includes("manifest") ? t("transfer.tooBig") : t("transfer.failed"));
        return;
      }
      const decision = onRemoteControl({ state: link.control, id: link.activeId }, control);
      link.control = decision.next.state;
      link.activeId = decision.next.id;
      if (decision.action === "reject-theirs" && control.t === "manifest") {
        sendControl({ t: "reject", id: control.id });
        return;
      }
      if (decision.action === "show" && control.t === "manifest") {
        link.manifest = { textBytes: control.textBytes, files: control.files };
        link.total = control.textBytes + control.files.reduce((sum, file) => sum + file.size, 0);
        const sender = get().peerName || t("transfer.peerPending");
        event({
          type: "incoming",
          id: control.id,
          at: now(),
          sender,
          textBytes: control.textBytes,
          files: control.files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
          total: link.total,
        });
        // No auto-accept: the offer waits in the timeline until the user answers it.
        show("confirm");
        tellIfClosed(t("transfer.toastOffer", { name: sender }));
        return;
      }
      if (decision.action === "accepted" && link.channel) {
        if (link.total === 0) {
          markBatch(control.id, "done");
          link.control = "ready";
          link.activeId = null;
          show("connected", t("transfer.sent"));
          return;
        }
        markBatch(control.id, "transfer");
        show("sending");
        api.sendLease();
        api.syncLease();
        void pump(link.channel);
        return;
      }
      if (decision.action === "declined") {
        markBatch(control.id, "declined");
        show("connected", t("transfer.declined"));
        return;
      }
      if (decision.action === "finished") {
        markBatch(control.id, "done");
        show("connected", t("transfer.sent"));
      }
      return;
    }
    if (link.control !== "receiving" || !link.manifest) return;
    const frame = new Uint8Array(data);
    const textChunk = decodeTextChunk(frame);
    const fileChunk = textChunk ? null : decodeChunk(frame);
    const chunk = textChunk ?? fileChunk;
    if (!chunk) {
      fail(t("transfer.failed"));
      return;
    }
    try {
      if (textChunk) {
        if (!link.textAssembler) link.textAssembler = new FileAssembler({ id: chunk.id, size: link.manifest.textBytes });
        const complete = link.textAssembler.push(chunk.offset, chunk.bytes);
        link.got += chunk.bytes.byteLength;
        if (complete) {
          link.textDone = true;
          const decoded = new TextDecoder().decode(link.textAssembler.bytes());
          const batchId = link.activeId;
          set((state) => ({ texts: [...state.texts, decoded] }));
          if (batchId) event({ type: "text", id: batchId, text: decoded });
          tellIfClosed(t("transfer.toastText"));
        }
      } else {
        const assembler = link.assemblers.get(chunk.id);
        const meta = link.manifest.files.find((file) => file.id === chunk.id);
        if (!assembler || !meta) {
          fail(t("transfer.failed"));
          return;
        }
        const complete = assembler.push(chunk.offset, chunk.bytes);
        link.got += chunk.bytes.byteLength;
        if (complete) {
          link.filesDone.add(chunk.id);
          const bytes = assembler.bytes();
          keepReceived({ id: meta.id, name: meta.name, mime: meta.mime, bytes });
          rememberPreviews([{ id: meta.id, mime: meta.mime, bytes, size: meta.size }]);
        }
      }
    } catch {
      fail(t("transfer.failed"));
      return;
    }
    publishProgress(link.got, link.total);
    finishReceive();
  }

  function accept() {
    const link = linkRef.current;
    const manifest = link.manifest;
    const channel = link.channel;
    if (!manifest || !channel || link.control !== "incoming" || !link.activeId) return;
    link.assemblers = new Map();
    link.textAssembler = null;
    link.filesDone = new Set();
    link.got = 0;
    for (const file of manifest.files) {
      link.assemblers.set(file.id, new FileAssembler({ id: file.id, size: file.size }));
      if (file.size === 0) link.filesDone.add(file.id);
    }
    link.textDone = manifest.textBytes === 0;
    const id = link.activeId;
    link.control = "receiving";
    markBatch(id, "transfer");
    sendControl({ t: "accept", id });
    show("receiving");
    finishReceive();
  }

  function reject() {
    const link = linkRef.current;
    if (!link.channel || link.control !== "incoming" || !link.activeId) return;
    markBatch(link.activeId, "declined");
    sendControl({ t: "reject", id: link.activeId });
    link.control = "ready";
    link.activeId = null;
    link.manifest = null;
    show("connected", t("transfer.connected"));
  }

  function onServer(message: ServerSignal) {
    const link = linkRef.current;
    if (message.type === "joined") {
      if (message.peerName) set({ peerName: message.peerName });
      if (link.role === "guest" || message.peerName) api.ensureSession();
      return;
    }
    if (message.type === "peer") {
      set({ peerName: message.deviceName });
      if (link.role === "host") api.ensureSession();
      if (get().phase === "hosting") show("joining", t("transfer.linkConnecting"));
      return;
    }
    if (message.type === "signal") {
      api.takeSignal(message.payload);
      return;
    }
    if (message.type === "expired" || (message.type === "rejected" && (message.reason === "expired" || message.reason === "closed"))) {
      const reason = message.type === "expired" ? message.reason : "invite";
      const key = reason === "idle" ? "transfer.idleEnded" : reason === "hard" ? "transfer.hardEnded" : "transfer.expired";
      fail(t(key));
      return;
    }
    if (message.type === "peer-left" || message.type === "rejected") {
      if (link.finished || link.quiet) return;
      if (message.type === "peer-left") api.clearRecovery();
      fail(message.type === "peer-left" ? t("transfer.peerLeft") : t("transfer.failed"));
    }
  }

  async function errorMessage(response: Response): Promise<string> {
    let error = "";
    try {
      const body = (await response.json()) as { error?: string };
      error = body.error || "";
    } catch {
      error = "";
    }
    if (response.status === 503 && error === "no-binding") return t("transfer.needsSite");
    if (response.status === 429) return t("transfer.rate");
    if (response.status === 400) return t("transfer.badCode");
    if (response.status === 409) return t("transfer.full");
    if (response.status === 404 || response.status === 410) return t("transfer.expired");
    return t("transfer.failed");
  }

  /** A fresh start: stale notices go, and already-saved files no longer need their bytes held. */
  function beginAttempt(): number {
    attempt += 1;
    timeline((entries) => reduceTimeline(entries, { type: "clear-stale" }));
    set((state) => ({ saves: state.saves.filter((file) => !state.savedIds.has(file.id)) }));
    return attempt;
  }

  async function createRoom() {
    const mine = beginAttempt();
    const current = () => linkRef.current.alive && attempt === mine;
    show("joining");
    const outcome = await takeRoomResponse(
      () =>
        deps.fetch("/api/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceName: deps.deviceName() }),
        }),
      current,
    );
    if (!outcome.ok) {
      if (outcome.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const response = outcome.value;
    if (!response.ok) {
      const message = await errorMessage(response);
      if (!current()) return;
      show("idle", message);
      return;
    }
    const parsed = await takeRoomResponse(() => response.json() as Promise<{ code?: string; hostToken?: string }>, current);
    if (!parsed.ok) {
      if (parsed.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const body = parsed.value;
    if (!body.code || !isRoomCode(body.code) || typeof body.hostToken !== "string") {
      show("idle", t("transfer.failed"));
      return;
    }
    set({ code: body.code });
    show("hosting", t("transfer.waiting"));
    api.openSocket("host", body.code, body.hostToken);
  }

  async function join(raw: string) {
    const mine = beginAttempt();
    const current = () => linkRef.current.alive && attempt === mine;
    const roomCode = raw.trim().toUpperCase();
    if (!isRoomCode(roomCode)) {
      show("idle", t("transfer.badCode"));
      return;
    }
    show("joining");
    const outcome = await takeRoomResponse(
      () =>
        deps.fetch("/api/transfer/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: roomCode, deviceName: deps.deviceName() }),
        }),
      current,
    );
    if (!outcome.ok) {
      if (outcome.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const response = outcome.value;
    if (!response.ok) {
      const message = await errorMessage(response);
      if (!current()) return;
      show("idle", message);
      return;
    }
    const parsed = await takeRoomResponse(() => response.json() as Promise<{ guestToken?: string; hostName?: string }>, current);
    if (!parsed.ok) {
      if (parsed.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const body = parsed.value;
    if (typeof body.guestToken !== "string") {
      show("idle", t("transfer.failed"));
      return;
    }
    if (body.hostName) set({ peerName: body.hostName });
    set({ code: roomCode });
    show("joining", t("transfer.waiting"));
    api.openSocket("guest", roomCode, body.guestToken);
  }

  /** 断开: end the room for both sides. */
  function disconnect() {
    attempt += 1;
    fail(t("transfer.youLeft"));
  }

  /** 重试 after a failure: back to the start screen, with a clean timeline head. */
  function retry() {
    const link = linkRef.current;
    link.finished = false;
    link.quiet = false;
    link.opened = false;
    link.control = "ready";
    link.activeId = null;
    beginAttempt();
    show("idle");
  }

  function markSaved(id: string) {
    set((state) => ({ savedIds: new Set(state.savedIds).add(id) }));
    revokeOne(id);
  }

  /** Remove a received file without saving it: its bytes and thumbnail are released. */
  function dismiss(id: string) {
    revokeOne(id);
    set((state) => {
      const savedIds = new Set(state.savedIds);
      savedIds.delete(id);
      return { saves: state.saves.filter((file) => file.id !== id), savedIds };
    });
  }

  function setPanelOpen(open: boolean) {
    if (get().panelOpen !== open) set({ panelOpen: open });
  }

  /** The tab is going away (or into the back/forward cache): close the room and the link. */
  function pageHide() {
    attempt += 1;
    api.dispose();
    revokeAll();
  }

  /** Back from the back/forward cache: the old link is gone, start over on a fresh one. */
  function pageShow(persisted: boolean) {
    if (!persisted || linkRef.current.alive) return;
    linkRef.current = freshLink();
    api = deps.createLink(linkRef, hooksRef);
    set({ phase: "idle", note: "", noteKey: null, code: "", peerName: "" });
  }

  /** A message on the start screen (camera or scanner problems), only while no session is running. */
  function idleNote(message: string) {
    if (get().phase === "idle") show("idle", message);
  }

  function visible() {
    api.nudge();
  }

  return {
    store,
    link: () => linkRef.current,
    offer,
    accept,
    reject,
    createRoom,
    join,
    disconnect,
    retry,
    markSaved,
    dismiss,
    setPanelOpen,
    pageHide,
    pageShow,
    visible,
    idleNote,
  };
}
