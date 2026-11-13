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
import { FileAssembler, StreamAssembler, type ByteSink } from "./assemble.ts";
import { generateCode, isRoomCode } from "./code.ts";
import { onRemoteControl } from "./control.ts";
import { MAX_FILE_BYTES, MAX_TEXT_BYTES } from "./limits.ts";
import { freshLink, type LanHooks, type LanLink, type TransferLink, type TransferPhase } from "./link.ts";
import { takeRoomResponse } from "./panel-flow.ts";
import { decodeChunk, decodeChunkV2, decodeControl, decodeTextChunk, type ControlLimits, type ControlMessage, type ManifestFile, type ServerSignal } from "./protocol.ts";
import { hashSlicedFile, waitBuffer, writeFileChunks, writeTextChunks } from "./send-chunks.ts";
import type { DataChannelLike } from "./session.ts";
import { capTimeline, crossedUnsavedLimit, MAX_TIMELINE, unsavedSummary } from "./session-state.ts";
import { StreamingSha256 } from "./sha256.ts";
import { detectStreamPlat, negotiatedLimits, type TransferLimits } from "./stream-cap.ts";
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
  /** For a file above the in-memory cap, open a disk sink before accepting. Null = cancelled or unavailable. */
  openSink?(file: { id: string; name: string; mime: string; size: number }): Promise<ByteSink | null>;
};

const THUMB_MAX = 10 * 1024 * 1024;

/** Sent over the data channel before an intentional disconnect, so the peer can tell it from a drop. */
export const BYE = JSON.stringify({ t: "bye" });

/** Notices after which the session is over for good: clear it back to the start screen. */
const GONE_KEYS = new Set(["transfer.peerLeft", "transfer.peerGone", "transfer.linkLost"]);

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
      onResumed: () => onResumed(),
    },
  };
  let api = deps.createLink(linkRef, hooksRef);
  // Each room attempt gets a number; a reply that arrives after 断开 or a newer attempt is dropped.
  let attempt = 0;
  let pumpGen = 0;
  let receiveTail = Promise.resolve();

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
      if (key && GONE_KEYS.has(key)) endSession({ keepUnsaved: true, note: key === "transfer.linkLost" ? t("transfer.peerGone") : message });
    }
  }

  /**
   * Back to the start screen: timeline, room code and peer are cleared. With keepUnsaved, files not
   * saved yet stay (with their batch, so they can still be saved) and the note says what happened.
   */
  function endSession(options: { keepUnsaved: boolean; note: string }) {
    attempt += 1;
    const link = linkRef.current;
    link.finished = false;
    link.quiet = false;
    link.opened = false;
    link.control = "ready";
    link.activeId = null;
    revokeAll();
    set((state) => {
      const unsaved = options.keepUnsaved ? state.saves.filter((file) => !state.savedIds.has(file.id)) : [];
      const held = new Set(unsaved.map((file) => file.id));
      const entries = state.entries.filter((entry) => entry.kind === "batch" && entry.files.some((file) => held.has(file.id)));
      const note = unsaved.length > 0 && options.note ? `${options.note} ${t("transfer.keptUnsaved", { count: unsaved.length })}` : options.note;
      return {
        phase: "idle",
        note,
        noteKey: null,
        entries,
        code: "",
        peerName: "",
        texts: [],
        saves: unsaved,
        savedIds: new Set(),
      };
    });
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

  function liveLimits(): TransferLimits {
    const link = linkRef.current;
    const plat = detectStreamPlat(typeof navigator !== "undefined" ? navigator.userAgent : "");
    return negotiatedLimits(plat, link.peerStreamV2 ? { v2: true, plat: link.peerPlat } : null);
  }

  function controlLimitsFor(limits: TransferLimits): ControlLimits {
    return {
      maxTextBytes: MAX_TEXT_BYTES,
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxBatchBytes: limits.maxBatchBytes,
      v2: limits.v2,
    };
  }

  function tooBigNote(): string {
    const limits = liveLimits();
    return t("transfer.tooBig", { file: deps.formatBytes(limits.maxFileBytes), batch: deps.formatBytes(limits.maxBatchBytes) });
  }

  function sentSoFar(link: TransferLink): number {
    const manifest = link.manifest;
    if (!manifest) return 0;
    let n = link.textSent ? manifest.textBytes : 0;
    for (const file of manifest.files) n += Math.min(file.size, link.sentOffsets.get(file.id) ?? 0);
    return n;
  }

  function assemblerOffset(link: TransferLink, file: ManifestFile): number {
    if (link.filesDone.has(file.id)) return file.size;
    const assembler = link.assemblers.get(file.id);
    if (assembler instanceof StreamAssembler) return assembler.offset;
    return 0;
  }

  function onResumed() {
    const link = linkRef.current;
    if (!link.peerStreamV2 || !link.channel || link.channel.readyState !== "open") return;
    if (link.control !== "receiving" || !link.manifest || !link.activeId) return;
    sendControl({
      t: "resume",
      id: link.activeId,
      files: link.manifest.files.map((file) => ({ id: file.id, offset: assemblerOffset(link, file) })),
    });
  }

  function verifyDigest(link: TransferLink): boolean {
    const digest = link.pendingDigest;
    const manifest = link.manifest;
    if (!digest || !manifest) return false;
    for (const file of manifest.files) {
      const expected = digest.find((row) => row.id === file.id)?.sha256;
      const assembler = link.assemblers.get(file.id);
      const actual = assembler instanceof StreamAssembler ? assembler.hex() : new StreamingSha256().hex();
      if (!expected || expected !== actual) return false;
    }
    return true;
  }

  function abortAssemblers(link: TransferLink): void {
    for (const assembler of link.assemblers.values()) {
      if (assembler instanceof StreamAssembler) void assembler.abort();
    }
  }

  function commitStreamedFiles(link: TransferLink) {
    if (!link.manifest) return;
    for (const file of link.manifest.files) {
      const assembler = link.assemblers.get(file.id);
      if (!(assembler instanceof StreamAssembler) || file.size === 0) {
        if (assembler instanceof StreamAssembler) void assembler.close();
        continue;
      }
      try {
        const bytes = assembler.bytes();
        keepReceived({ id: file.id, name: file.name, mime: file.mime, bytes });
        rememberPreviews([{ id: file.id, mime: file.mime, bytes, size: file.size }]);
      } catch {
        keepReceived({ id: file.id, name: file.name, mime: file.mime, bytes: new Uint8Array(0) });
        markSaved(file.id);
      }
      void assembler.close();
    }
  }

  function sendControl(message: ControlMessage) {
    if ((message.t === "resume" || message.t === "digest") && !linkRef.current.peerStreamV2) return;
    const channel = linkRef.current.channel;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(message));
    api.sendLease();
    api.syncLease();
  }

  function describe(text: string, files: File[]): { textBytes: number; files: ManifestFile[] } | "empty" | "too-big" {
    const limits = liveLimits();
    const textBytes = new TextEncoder().encode(text).byteLength;
    if (textBytes === 0 && files.length === 0) return "empty";
    if (textBytes > MAX_TEXT_BYTES || files.length > limits.maxFiles) return "too-big";
    if (files.some((file) => !Number.isInteger(file.size) || file.size > limits.maxFileBytes)) return "too-big";
    const batch = files.reduce((sum, file) => sum + file.size, textBytes);
    if (batch > limits.maxBatchBytes) return "too-big";
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
      show("connected", tooBigNote());
      return false;
    }
    const id = newId();
    link.activeId = id;
    link.control = "outgoing";
    link.snapshotText = text;
    link.snapshotFiles = files.slice();
    link.manifest = described;
    link.total = described.textBytes + described.files.reduce((sum, file) => sum + file.size, 0);
    link.sentOffsets = new Map();
    link.textSent = false;
    link.pendingDigest = null;
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
    const gen = (pumpGen += 1);
    const cancelled = () => gen !== pumpGen;
    const limits = liveLimits();
    try {
      const encoded = new TextEncoder().encode(link.snapshotText);
      if (encoded.byteLength > 0 && !link.textSent) {
        await writeTextChunks(channel, newId(), encoded, (at) => {
          publishProgress(at + sentSoFar(link), link.total);
        });
        if (cancelled()) return;
        link.textSent = true;
      }
      for (let index = 0; index < manifest.files.length; index += 1) {
        if (cancelled()) return;
        const meta = manifest.files[index]!;
        const file = link.snapshotFiles[index];
        const start = link.sentOffsets.get(meta.id) ?? 0;
        if (!file || meta.size === 0 || start >= meta.size) {
          if (meta.size === 0) link.sentOffsets.set(meta.id, 0);
          continue;
        }
        await writeFileChunks(channel, meta.id, file, {
          v2: limits.v2,
          start,
          chunkBytes: limits.chunkBytes,
          isCancelled: cancelled,
          onProgress: (at) => {
            link.sentOffsets.set(meta.id, at);
            publishProgress(sentSoFar(link), link.total);
          },
        });
        if (cancelled()) return;
        link.sentOffsets.set(meta.id, meta.size);
      }
      await waitBuffer(channel, 0);
      if (cancelled()) return;
      if (limits.v2 && link.activeId) {
        const files: { id: string; sha256: string }[] = [];
        for (let index = 0; index < manifest.files.length; index += 1) {
          if (cancelled()) return;
          const meta = manifest.files[index]!;
          const file = link.snapshotFiles[index];
          files.push({ id: meta.id, sha256: file ? await hashSlicedFile(file) : new StreamingSha256().hex() });
        }
        if (cancelled()) return;
        sendControl({ t: "digest", id: link.activeId, files });
      }
    } catch {
      if (cancelled()) return;
      if (channel.readyState !== "open") api.applyFault("dc-close");
      else fail(t("transfer.failed"));
    }
  }

  function finishReceive() {
    const link = linkRef.current;
    if (link.control !== "receiving" || !link.manifest || !link.activeId) return;
    const filesComplete = link.manifest.files.every((file) => file.size === 0 || link.filesDone.has(file.id));
    if (!link.textDone || !filesComplete) return;
    if (link.peerStreamV2 && link.total > 0) {
      if (!link.pendingDigest) return;
      if (!verifyDigest(link)) {
        abortAssemblers(link);
        fail(t("transfer.digestFail"));
        return;
      }
      commitStreamedFiles(link);
    }
    const id = link.activeId;
    markBatch(id, "done");
    link.control = "ready";
    link.activeId = null;
    link.pendingDigest = null;
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
      if (data === BYE) {
        api.clearRecovery();
        fail(t("transfer.peerLeft"));
        return;
      }
      const limits = liveLimits();
      const control = decodeControl(data, controlLimitsFor(limits));
      if (!control) {
        fail(data.includes("manifest") ? tooBigNote() : t("transfer.failed"));
        return;
      }
      if (control.t === "resume") {
        if (!limits.v2 || link.control !== "sending" || control.id !== link.activeId || !link.channel) return;
        for (const file of control.files) link.sentOffsets.set(file.id, file.offset);
        void pump(link.channel);
        return;
      }
      if (control.t === "digest") {
        if (!limits.v2 || link.control !== "receiving" || control.id !== link.activeId) return;
        link.pendingDigest = control.files;
        finishReceive();
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
    const apply = async () => {
      const live = linkRef.current;
      if (live.control !== "receiving" || !live.manifest) return;
      const frame = new Uint8Array(data);
      const textChunk = decodeTextChunk(frame);
      const fileChunk = textChunk ? null : live.peerStreamV2 ? decodeChunkV2(frame) : decodeChunk(frame);
      const chunk = textChunk ?? fileChunk;
      if (!chunk) {
        fail(t("transfer.failed"));
        return;
      }
      try {
        if (textChunk) {
          if (!live.textAssembler) live.textAssembler = new FileAssembler({ id: chunk.id, size: live.manifest.textBytes });
          const complete = live.textAssembler.push(chunk.offset, chunk.bytes);
          live.got += chunk.bytes.byteLength;
          if (complete) {
            live.textDone = true;
            const decoded = new TextDecoder().decode(live.textAssembler.bytes());
            const batchId = live.activeId;
            set((state) => ({ texts: [...state.texts, decoded] }));
            if (batchId) event({ type: "text", id: batchId, text: decoded });
            tellIfClosed(t("transfer.toastText"));
          }
        } else {
          const assembler = live.assemblers.get(chunk.id);
          const meta = live.manifest.files.find((file) => file.id === chunk.id);
          if (!assembler || !meta) {
            fail(t("transfer.failed"));
            return;
          }
          const complete = assembler instanceof StreamAssembler ? await assembler.push(chunk.offset, chunk.bytes) : assembler.push(chunk.offset, chunk.bytes);
          live.got += chunk.bytes.byteLength;
          if (complete) {
            live.filesDone.add(chunk.id);
            if (!live.peerStreamV2) {
              const bytes = assembler.bytes();
              keepReceived({ id: meta.id, name: meta.name, mime: meta.mime, bytes });
              rememberPreviews([{ id: meta.id, mime: meta.mime, bytes, size: meta.size }]);
            }
          }
        }
      } catch {
        fail(t("transfer.failed"));
        return;
      }
      publishProgress(live.got, live.total);
      finishReceive();
    };
    if (link.peerStreamV2) receiveTail = receiveTail.then(apply, () => undefined);
    else void apply();
  }

  async function accept() {
    const link = linkRef.current;
    const manifest = link.manifest;
    const channel = link.channel;
    if (!manifest || !channel || link.control !== "incoming" || !link.activeId) return;
    const limits = liveLimits();
    const next = new Map<string, FileAssembler | StreamAssembler>();
    const opened: StreamAssembler[] = [];
    try {
      if (limits.v2) {
        for (const file of manifest.files) {
          let sink: ByteSink | undefined;
          if (file.size > MAX_FILE_BYTES) {
            sink = (await deps.openSink?.(file)) ?? undefined;
            if (!sink) {
              for (const assembler of opened) await assembler.abort();
              show("confirm", t("transfer.needSink"));
              return;
            }
          }
          const assembler = new StreamAssembler({ id: file.id, size: file.size, sink });
          next.set(file.id, assembler);
          opened.push(assembler);
        }
      } else {
        for (const file of manifest.files) {
          next.set(file.id, new FileAssembler({ id: file.id, size: file.size }));
        }
      }
    } catch {
      for (const assembler of opened) await assembler.abort();
      fail(t("transfer.failed"));
      return;
    }
    link.assemblers = next;
    link.textAssembler = null;
    link.filesDone = new Set();
    link.got = 0;
    link.pendingDigest = null;
    for (const file of manifest.files) {
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
      if (message.type === "peer-left") {
        fail(message.reason === "gone" ? t("transfer.peerGone") : message.reason === "direct-failed" ? t("transfer.failed") : t("transfer.peerLeft"));
      }
      else fail(t("transfer.failed"));
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

  /**
   * 断开: tell the peer (data channel, then the room via cancel), end the room and go back to the
   * start screen. Unsaved received files are dropped, so the panel asks first (unsavedCount).
   */
  function disconnect() {
    attempt += 1;
    sendBye();
    fail(t("transfer.youLeft"));
    endSession({ keepUnsaved: false, note: "" });
  }

  function sendBye() {
    const channel = linkRef.current.channel;
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(BYE);
    } catch {
      // Closing anyway; the room's cancel still reaches the peer.
    }
  }

  function unsavedCount(): number {
    const state = get();
    return state.saves.filter((file) => !state.savedIds.has(file.id)).length;
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
    // Closing the tab is a deliberate leave: say bye so the peer clears at once instead of waiting 10 minutes.
    sendBye();
    api.fail(t("transfer.youLeft"));
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
    unsavedCount,
  };
}
