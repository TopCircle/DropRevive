import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import QRCode from "qrcode";
import { Flashlight, FlashlightOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TransferThread, type ThreadFile } from "@/components/drop/transfer-thread";
import { linkChipClass } from "@/components/drop/link-chip";
import { useDropStore } from "@/lib/drop/store";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/types";
import { FileAssembler } from "@/lib/transfer/assemble";
import { generateCode, isRoomCode } from "@/lib/transfer/code";
import { onRemoteControl } from "@/lib/transfer/control";
import { ASSUMED_MAX_MESSAGE, BUFFERED_HIGH, CHUNK_BYTES, MAX_BATCH_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_TEXT_BYTES } from "@/lib/transfer/limits";
import { createLanLink, freshLink, stopMedia, type LanHooks, type LanLink, type TransferLink, type TransferPhase } from "@/lib/transfer/link";
import { decodeChunk, decodeControl, decodeTextChunk, encodeChunk, encodeTextChunk, type ManifestFile, type ServerSignal } from "@/lib/transfer/protocol";
import { createJsqrDecoder, createNativeDecoder, createScanEngine, formatDebug, grabFrame, judgeScan, NOTHING_READ_MS, scanErrorKey, describeError, type Decoder, type JsQr } from "@/lib/transfer/scan-decode";
import { cameraConstraints, prepareCamera, setTorch, supportsPointsOfInterest, tapFocus, tapPoint, viewfinderAspect } from "@/lib/transfer/scan-camera";
import { receivedWouldDrop, takeRoomResponse, withoutTransferSearch } from "@/lib/transfer/panel-flow";
import type { DataChannelLike } from "@/lib/transfer/session";
import {
  CONNECTION_NOTICES,
  linkVisual,
  offerBlocked,
  openBatchFails,
  reduceTimeline,
  sessionVisible,
  stickToEnd,
  type TimelineEntry,
} from "@/lib/transfer/timeline";

type Phase = TransferPhase;

type Saveable = ThreadFile;

type LiveChannel = DataChannelLike & {
  maxMessageSize?: number;
  bufferedAmount?: number;
  onbufferedamountlow: (() => void) | null;
};

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>> };
type DetectorCtor = (new (options?: { formats?: string[] }) => Detector) & { getSupportedFormats?: () => Promise<string[]> };

async function loadJsqrDecoder(): Promise<Decoder<HTMLVideoElement>> {
  const mod = await import("jsqr");
  const canvas = document.createElement("canvas");
  return createJsqrDecoder<HTMLVideoElement>(mod.default as JsQr, (video) => grabFrame(video, canvas));
}

function deviceName(): string {
  return useDropStore.getState().settings.deviceName || "device";
}

function newId(): string {
  return generateCode(() => crypto.getRandomValues(new Uint8Array(8)));
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

const THUMB_MAX = 10 * 1024 * 1024;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

type SavePicker = (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;

async function saveOne(file: Saveable, label: string): Promise<boolean> {
  const blob = new Blob([ownedBuffer(file.bytes)], { type: file.mime || "application/octet-stream" });
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({ suggestedName: file.name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast.success(label);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  toast.success(label);
  return true;
}

export function TransferPanel({
  compact = false,
  frameClassName = "",
  text,
  files,
  onUseCloud,
  onHold,
  onAlsoCloud,
  onClearDraft,
  alsoCloudLabel,
  composer,
}: {
  compact?: boolean;
  frameClassName?: string;
  text: string;
  files: File[];
  onUseCloud?: () => void;
  onHold?: (held: boolean) => void;
  onAlsoCloud?: () => void;
  onClearDraft?: () => void;
  alsoCloudLabel?: string;
  composer: ReactElement<{ hideSend?: boolean; directSend?: { label: string; disabled?: boolean; onSend: () => void } }>;
}) {
  const { t } = useI18n();
  const linkRef = useRef<TransferLink>(freshLink());
  const hooksRef = useRef<LanHooks>({
    say() {},
    note() {},
    text: () => "",
    onData() {},
    onServer() {},
  });
  const apiRef = useRef<LanLink | null>(null);
  if (!apiRef.current) apiRef.current = createLanLink(linkRef, hooksRef);
  const api = apiRef.current;
  const textRef = useRef(text);
  const filesRef = useRef(files);
  const videoRef = useRef<HTMLVideoElement>(null);
  textRef.current = text;
  filesRef.current = files;

  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [keyboard, setKeyboard] = useState(0);
  const [entry, setEntry] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState("");
  const [peerName, setPeerName] = useState("");
  const [texts, setTexts] = useState<string[]>([]);
  const phaseRef = useRef<Phase>("idle");
  const peerRef = useRef("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  phaseRef.current = phase;
  peerRef.current = peerName;
  const textReady = texts.length > 0;
  const [saves, setSaves] = useState<Saveable[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewUrls = useRef<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const lastOtherHostRef = useRef("");
  const [scanAspect, setScanAspect] = useState(viewfinderAspect(0, 0));
  const [debugOn, setDebugOn] = useState(false);
  const [debugText, setDebugText] = useState("");
  const engineRef = useRef<ReturnType<typeof createScanEngine<HTMLVideoElement>> | null>(null);
  const loopRef = useRef(0);
  const lastRawRef = useRef("");
  const lastOutcomeRef = useRef("");
  const formatsRef = useRef("n/a");

  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incoming = (params.get("transfer") || "").toUpperCase();
    if (isRoomCode(incoming)) setEntry(incoming);
  }, []);

  useEffect(() => {
    const pendingFiles = saves.filter((file) => !savedIds.has(file.id)).length;
    const active = phase === "hosting" || phase === "joining" || phase === "connected" || phase === "offering" || phase === "confirm" || phase === "sending" || phase === "receiving";
    onHold?.(active || receivedWouldDrop({ textReady, pendingFiles }));
    return () => onHold?.(false);
  }, [onHold, phase, saves, savedIds, textReady]);

  useEffect(() => {
    const video = videoRef.current;
    if (!scanning || !video) return;
    // The box takes the feed's shape; the size changes when the phone rotates.
    const sync = () => setScanAspect(viewfinderAspect(video.videoWidth, video.videoHeight));
    sync();
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("resize", sync);
    return () => {
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("resize", sync);
    };
  }, [scanning]);

  useEffect(() => {
    if (!scanning || !debugOn) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const track = trackRef.current;
      const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands;
      setDebugText(
        formatDebug({
          hasNative: "BarcodeDetector" in window,
          secure: window.isSecureContext,
          formats: formatsRef.current,
          info: engineRef.current?.info() ?? { decoder: null, frames: 0, nativeError: null, lastError: null, switchedFromNative: null },
          lastRaw: lastRawRef.current,
          lastOutcome: lastOutcomeRef.current,
          origin: window.location.origin,
          video: video ? { readyState: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight } : null,
          settings: track?.getSettings?.(),
          capabilities: track?.getCapabilities?.(),
          userAgent: navigator.userAgent,
          brands: brands?.map((item) => `${item.brand} ${item.version}`).join(", ") || "n/a",
        }),
      );
    }, 500);
    return () => window.clearInterval(timer);
  }, [scanning, debugOn]);

  useEffect(() => {
    if (scanning) return;
    window.clearTimeout(loopRef.current);
    toast.dismiss("scan-timeout");
    // Closing the viewfinder stops the track (which also turns the torch off); drop its UI state.
    trackRef.current = null;
    setTorchAvailable(false);
    setTorchOn(false);
  }, [scanning]);

  useEffect(() => {
    if (!code) return;
    const page = `${window.location.origin}/?transfer=${code}`;
    let cancelled = false;
    void QRCode.toDataURL(page, { margin: 1, width: compact ? 180 : 240 }).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [code, compact]);

  useEffect(() => {
    const link = linkRef.current;
    link.alive = true;
    link.quiet = false;
    link.finished = false;
    // The array is only ever appended to, so this is the same list the cleanup must revoke.
    const urls = previewUrls.current;
    return () => {
      api.dispose();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [api]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setKeyboard(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    };
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    sync();
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, []);

  function noteKeyFor(message: string): string | null {
    if (!message) return null;
    for (const key of Object.keys(CONNECTION_NOTICES)) {
      if (t(key as MessageKey) === message) return key;
    }
    return null;
  }

  function applySurface(next: Phase | null, message: string) {
    const key = noteKeyFor(message);
    const phaseForFail = next ?? phaseRef.current;
    if (next) {
      phaseRef.current = next;
      setPhase(next);
    }
    setNote(message);
    setNoteKey(key);
    setEntries((current) => {
      if (!sessionVisible(phaseForFail)) return current;
      let nextEntries = next === "connected" ? reduceTimeline(current, { type: "clear-stale" }) : current;
      if (openBatchFails(key, phaseForFail)) nextEntries = reduceTimeline(nextEntries, { type: "fail-open" });
      const tone = key ? CONNECTION_NOTICES[key] : null;
      if (tone !== "reconnect") nextEntries = reduceTimeline(nextEntries, { type: "clear-reconnect" });
      if (tone && message) nextEntries = reduceTimeline(nextEntries, { type: "notice", at: Date.now(), tone, text: message });
      return nextEntries;
    });
  }

  function show(next: Phase, message = "") {
    if (!linkRef.current.alive) return;
    applySurface(next, message);
  }

  function showNote(message: string) {
    if (!linkRef.current.alive) return;
    applySurface(null, message);
  }

  function markBatch(id: string | null, status: "waiting" | "confirm" | "transfer" | "done" | "declined" | "failed") {
    if (!id) return;
    setEntries((current) => reduceTimeline(current, { type: "status", id, status }));
  }

  function publishProgress(done: number, total: number) {
    const id = linkRef.current.activeId;
    if (!id) return;
    setEntries((current) => reduceTimeline(current, { type: "progress", id, done, total }));
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

  function offerCurrent() {
    const link = linkRef.current;
    const channel = link.channel;
    if (!channel || channel.readyState !== "open" || link.control !== "ready") return;
    const described = describe(textRef.current, filesRef.current);
    if (described === "empty") {
      show("connected", t("transfer.empty"));
      return;
    }
    if (described === "too-big") {
      show("connected", t("transfer.tooBig"));
      return;
    }
    const id = newId();
    link.activeId = id;
    link.control = "outgoing";
    link.snapshotText = textRef.current;
    link.snapshotFiles = filesRef.current.slice();
    link.manifest = described;
    link.total = described.textBytes + described.files.reduce((sum, file) => sum + file.size, 0);
    setEntries((current) =>
      reduceTimeline(current, {
        type: "offer",
        id,
        at: Date.now(),
        sender: deviceName(),
        text: textRef.current,
        files: described.files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
        total: link.total,
      }),
    );
    sendControl({ t: "manifest", id, textBytes: described.textBytes, files: described.files });
    rememberPreviews(described.files.map((meta, index) => ({ id: meta.id, file: filesRef.current[index] })));
    onClearDraft?.();
    show("offering", t("transfer.waitingAccept"));
  }

  function rememberPreviews(items: { id: string; file?: File; mime?: string; bytes?: Uint8Array; size?: number }[]) {
    const next: Record<string, string> = {};
    for (const item of items) {
      const mime = item.file?.type || item.mime || "";
      const size = item.file?.size ?? item.size ?? 0;
      if (!mime.startsWith("image/") || size <= 0 || size > THUMB_MAX) continue;
      const url = item.file
        ? URL.createObjectURL(item.file)
        : item.bytes
          ? URL.createObjectURL(new Blob([ownedBuffer(item.bytes)], { type: mime }))
          : "";
      if (!url) continue;
      next[item.id] = url;
      previewUrls.current.push(url);
    }
    if (Object.keys(next).length > 0) setPreviews((current) => ({ ...current, ...next }));
  }

  async function pump(channel: DataChannelLike) {
    const link = linkRef.current;
    const manifest = link.manifest;
    if (!manifest) return;
    try {
      const encoded = new TextEncoder().encode(link.snapshotText);
      let sent = 0;
      if (encoded.byteLength > 0) {
        const textId = newId();
        await writeChunks(channel, textId, encoded, true, (at) => {
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
        setEntries((current) =>
          reduceTimeline(current, {
            type: "incoming",
            id: control.id,
            at: Date.now(),
            sender: peerRef.current || t("transfer.peerPending"),
            textBytes: control.textBytes,
            files: control.files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
            total: link.total,
          }),
        );
        show("confirm");
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
          setTexts((current) => [...current, decoded]);
          if (batchId) setEntries((current) => reduceTimeline(current, { type: "text", id: batchId, text: decoded }));
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
          setSaves((current) => [...current, { id: meta.id, name: meta.name, mime: meta.mime, bytes }]);
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

  function acceptOffer() {
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

  function rejectOffer() {
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
      if (message.peerName) setPeerName(message.peerName);
      if (link.role === "guest" || message.peerName) api.ensureSession();
      return;
    }
    if (message.type === "peer") {
      setPeerName(message.deviceName);
      if (link.role === "host") api.ensureSession();
      if (phaseRef.current === "hosting") show("joining", t("transfer.linkConnecting"));
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

  function clearStale() {
    setEntries((current) => reduceTimeline(current, { type: "clear-stale" }));
  }

  async function createRoom() {
    clearStale();
    show("joining");
    const outcome = await takeRoomResponse(
      () =>
        fetch("/api/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceName: deviceName() }),
        }),
      () => linkRef.current.alive,
    );
    if (!outcome.ok) {
      if (outcome.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const response = outcome.value;
    if (!response.ok) {
      const message = await errorMessage(response);
      if (!linkRef.current.alive) return;
      show("idle", message);
      return;
    }
    const parsed = await takeRoomResponse(
      () => response.json() as Promise<{ code?: string; hostToken?: string }>,
      () => linkRef.current.alive,
    );
    if (!parsed.ok) {
      if (parsed.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const body = parsed.value;
    if (!body.code || !isRoomCode(body.code) || typeof body.hostToken !== "string") {
      show("idle", t("transfer.failed"));
      return;
    }
    setCode(body.code);
    show("hosting", t("transfer.waiting"));
    api.openSocket("host", body.code, body.hostToken);
  }

  async function join(raw: string) {
    clearStale();
    const roomCode = raw.trim().toUpperCase();
    if (!isRoomCode(roomCode)) {
      show("idle", t("transfer.badCode"));
      return;
    }
    forgetEnteredCode();
    stopMedia(linkRef.current);
    setScanning(false);
    show("joining");
    const outcome = await takeRoomResponse(
      () =>
        fetch("/api/transfer/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: roomCode, deviceName: deviceName() }),
        }),
      () => linkRef.current.alive,
    );
    if (!outcome.ok) {
      if (outcome.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const response = outcome.value;
    if (!response.ok) {
      const message = await errorMessage(response);
      if (!linkRef.current.alive) return;
      show("idle", message);
      return;
    }
    const parsed = await takeRoomResponse(
      () => response.json() as Promise<{ guestToken?: string; hostName?: string }>,
      () => linkRef.current.alive,
    );
    if (!parsed.ok) {
      if (parsed.reason === "thrown") show("idle", t("transfer.failed"));
      return;
    }
    const body = parsed.value;
    if (typeof body.guestToken !== "string") {
      show("idle", t("transfer.failed"));
      return;
    }
    if (body.hostName) setPeerName(body.hostName);
    setCode(roomCode);
    show("joining", t("transfer.waiting"));
    api.openSocket("guest", roomCode, body.guestToken);
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

  function stopScanner() {
    window.clearTimeout(loopRef.current);
    loopRef.current = 0;
    stopMedia(linkRef.current);
    setScanning(false);
  }

  async function scan() {
    lastOtherHostRef.current = "";
    setDebugText("");
    lastRawRef.current = "";
    lastOutcomeRef.current = "";
    setDebugOn(new URLSearchParams(window.location.search).get("scandebug") === "1");
    if (!navigator.mediaDevices?.getUserMedia) {
      show("idle", t("transfer.scanMissing"));
      return;
    }
    const Ctor = (window as Window & { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    formatsRef.current = Ctor ? "pending" : "n/a";
    if (Ctor?.getSupportedFormats) {
      void Ctor.getSupportedFormats().then(
        (formats) => (formatsRef.current = formats.join(",") || "(empty)"),
        (error) => (formatsRef.current = `error ${describeError(error).name}: ${describeError(error).message}`),
      );
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
      const link = linkRef.current;
      if (!link.alive) {
        // The panel went away while the camera was opening: release it instead of leaking it.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      stopMedia(link);
      link.stream = stream;
      const track = stream.getVideoTracks()[0];
      trackRef.current = track ?? null;
      if (track) void prepareCamera(track).then((features) => {
        if (trackRef.current === track) setTorchAvailable(features.torch);
      });
      setScanning(true);
      const video = videoRef.current;
      if (!video) {
        stopMedia(link);
        return;
      }
      video.srcObject = stream;
      await video.play();
      const engine = createScanEngine<HTMLVideoElement>({ native: Ctor ? () => createNativeDecoder<HTMLVideoElement>(Ctor) : undefined, jsqr: loadJsqrDecoder });
      engineRef.current = engine;
      const chosen = await engine.start();
      if (link.stream !== stream) return;
      if (!chosen) {
        stopScanner();
        show("idle", t("transfer.scanNoDecoder"));
        return;
      }
      const begun = Date.now();
      let hinted = false;
      const tick = async () => {
        loopRef.current = 0;
        const live = videoRef.current;
        if (link.stream !== stream || !live) return;
        if (document.hidden) {
          loopRef.current = window.setTimeout(() => void tick(), 500);
          return;
        }
        const result = await engine.step(live);
        if (link.stream !== stream) return;
        if (result.dead) {
          stopScanner();
          show("idle", t("transfer.scanNoDecoder"));
          return;
        }
        for (const raw of result.raws) {
          lastRawRef.current = raw;
          const outcome = judgeScan(raw, window.location.origin);
          lastOutcomeRef.current = outcome.kind === "ok" ? `yes (${outcome.code})` : outcome.kind === "other-site" ? `no: other site ${outcome.host}` : `no: ${outcome.kind}`;
          if (outcome.kind === "ok") {
            stopScanner();
            void join(outcome.code);
            return;
          }
          if (outcome.kind === "other-site" && lastOtherHostRef.current !== outcome.host) {
            // A toast floats over the page, so it never changes the viewfinder's size.
            lastOtherHostRef.current = outcome.host;
            toast.message(t("transfer.scanOtherSite", { host: outcome.host }));
          }
        }
        if (!hinted && !lastRawRef.current && Date.now() - begun >= NOTHING_READ_MS) {
          hinted = true;
          toast.message(t("transfer.scanTimeout"), { id: "scan-timeout", duration: 8000 });
        }
        if (engine.info().decoder === "jsqr") {
          // About 9 frames a second is plenty for a QR and keeps the phone cool.
          loopRef.current = window.setTimeout(() => void tick(), 110);
        } else {
          link.scan = requestAnimationFrame(() => void tick());
        }
      };
      link.scan = requestAnimationFrame(() => void tick());
    } catch (error) {
      stopScanner();
      show("idle", t(scanErrorKey(error)));
    }
  }

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    if (await setTorch(track, next)) setTorchOn(next);
  }

  function focusAt(event: ReactMouseEvent<HTMLVideoElement>) {
    const track = trackRef.current;
    if (!track) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const video = event.currentTarget;
    const point = tapPoint(box, { width: video.videoWidth, height: video.videoHeight }, { x: event.clientX, y: event.clientY });
    void tapFocus(track, point, { pointsOfInterest: supportsPointsOfInterest() });
  }

  function forgetEnteredCode() {
    setEntry("");
    const next = withoutTransferSearch(window.location.search);
    const target = `${window.location.pathname}${next}${window.location.hash}`;
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", target);
    }
  }

  function userCancel() {
    setScanning(false);
    fail(t("transfer.youLeft"));
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  hooksRef.current = {
    say: show,
    note: showNote,
    text: (key) => t(key),
    onData: onChannel,
    onServer,
  };

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    if (!sessionVisible(phase)) {
      node.scrollTop = 0;
      stickRef.current = true;
      return;
    }
    if (!stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [entries, phase]);

  const visual = linkVisual(phase, noteKey);
  const inRoom = sessionVisible(phase);
  const canDisconnect = phase !== "idle" && phase !== "failed";
  const composerNode = cloneElement(composer, {
    hideSend: true,
    directSend:
      inRoom && phase !== "failed"
        ? {
            label: t("transfer.send"),
            disabled: offerBlocked(phase, noteKey),
            onSend: offerCurrent,
          }
        : undefined,
  });

  function linkLabel(): string {
    if (visual === "connecting") return t("transfer.linkConnecting");
    if (visual === "waiting") return t("transfer.waiting");
    if (visual === "reconnecting") return t("transfer.linkReconnecting");
    if (visual === "ended") return t("transfer.linkEnded");
    if (visual === "failed") return t("transfer.linkFailed");
    return t("transfer.linkLive");
  }

  function saveReceived(file: Saveable) {
    void saveOne(file, t("transfer.saved", { name: file.name })).then((saved) => {
      if (!saved || !linkRef.current.alive) return;
      setSavedIds((current) => new Set(current).add(file.id));
    });
  }

  const sessionActions = (
    <>
      {inRoom && (
        <p role="status" className={`inline-flex h-7 items-center rounded-full px-2 text-xs ${linkChipClass(visual)}`}>
          {linkLabel()}
        </p>
      )}
      {canDisconnect && (
        <Button variant="ghost" size={frameClassName ? "sm" : "md"} onClick={userCancel}>
          {t("transfer.disconnect")}
        </Button>
      )}
    </>
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {frameClassName && (
        <div className={`${frameClassName} grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 py-1.5 ${inRoom ? "border-b border-border" : ""}`}>
          <div className="min-w-0">
            {inRoom && (
              <>
                <p className="truncate text-sm font-medium leading-5">{peerName || t("transfer.peerPending")}</p>
                <p className="truncate text-xs leading-4 text-muted-foreground">{t("transfer.foreground")}</p>
              </>
            )}
          </div>
          <h2 className="truncate text-center text-lg font-semibold text-foreground">{t("nav.lan")}</h2>
          <div className="flex items-center justify-end gap-2">{sessionActions}</div>
        </div>
      )}
      {inRoom && !frameClassName ? (
        <header className="flex items-center justify-between gap-2 border-b border-border py-1">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-5">{peerName || t("transfer.peerPending")}</p>
            <p className="text-xs leading-4 text-muted-foreground">{t("transfer.foreground")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">{sessionActions}</div>
        </header>
      ) : (
        !inRoom && (
          <p className={`text-sm text-muted-foreground ${frameClassName} ${compact ? "py-2 leading-5" : "py-3 leading-6"}`}>{t("send.directHint")}</p>
        )
      )}
      <div
        ref={scrollerRef}
        onScroll={() => {
          const node = scrollerRef.current;
          if (!node) return;
          stickRef.current = stickToEnd(node.scrollTop, node.scrollHeight, node.clientHeight);
        }}
        className={
          frameClassName
            ? `scrollbar-pill flex min-h-0 min-w-0 flex-1 flex-col ${scanning ? "overflow-y-hidden" : "overflow-y-auto"} [scrollbar-gutter:stable_both-edges]`
            : "scrollbar-pill flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
        }
      >
        <div className={frameClassName ? `${frameClassName} flex min-w-0 flex-col ${scanning ? "min-h-0 flex-1" : ""}` : "contents"}>
        {phase === "idle" && (
          <div className="flex shrink-0 flex-col gap-3 pb-3">
            <Button onClick={() => void createRoom()}>{t("transfer.create")}</Button>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void join(entry);
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">{t("transfer.code")}</span>
                <input
                  value={entry}
                  onChange={(event) => setEntry(event.target.value.toUpperCase())}
                  placeholder={t("transfer.placeholder")}
                  autoCapitalize="characters"
                  className="h-11 w-full rounded-xl border border-border bg-transparent px-3 font-mono text-sm outline-none"
                />
              </label>
              <Button type="submit" variant="secondary" className="shrink-0">
                {t("transfer.join")}
              </Button>
              <Button variant="ghost" className="shrink-0" onClick={() => void scan()}>
                {t("transfer.scan")}
              </Button>
            </form>
            {note && (
              <p role="alert" className="text-sm">
                {note}
              </p>
            )}
          </div>
        )}
        <div className={scanning ? `scan-stage flex flex-1 items-center justify-center ${compact ? "min-h-[12rem]" : "min-h-0"}` : "contents"}>
          <div className={scanning ? "relative flex" : "contents"}>
            <video
              ref={videoRef}
              className={scanning ? "scan-viewfinder rounded-xl bg-black object-cover" : "hidden"}
              style={scanning ? ({ "--scan-aspect": scanAspect } as CSSProperties) : undefined}
              muted
              playsInline
              onClick={focusAt}
            />
            {scanning && torchAvailable && (
              <button
                type="button"
                aria-label={t("transfer.torch")}
                title={t("transfer.torch")}
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
                className="absolute bottom-3 right-3 flex size-10 items-center justify-center rounded-full bg-black/55 text-white"
              >
                {torchOn ? <FlashlightOff className="size-5" /> : <Flashlight className="size-5" />}
              </button>
            )}
            {scanning && debugOn && (
              <div className="absolute inset-x-1 top-1 z-10 max-h-[70%] overflow-auto rounded-lg bg-black/80 p-2 text-left text-[10px] leading-snug text-green-300">
                <pre className="whitespace-pre-wrap break-all font-mono">{debugText || "starting…"}</pre>
                <div className="mt-1 flex gap-3">
                  <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(debugText).catch(() => undefined)}>
                    Copy
                  </button>
                  <button type="button" className="underline" onClick={() => setDebugOn(false)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {phase === "joining" && (
          <div role="status" className="mb-3 rounded-2xl border border-border px-3 py-3">
            {peerName && <p className="truncate text-sm font-medium">{peerName}</p>}
            <p className={`text-sm ${peerName ? "mt-1 text-muted-foreground" : ""}`}>{t("transfer.linkConnecting")}</p>
          </div>
        )}
        {qr && phase === "hosting" && (
          <div className="mb-3 flex flex-col items-start gap-2">
            <img src={qr} alt="" className="rounded-xl bg-white p-2" />
            <p className="font-mono text-lg tracking-widest">{code}</p>
            <p role="status" className="text-sm text-muted-foreground">
              {note || t("transfer.waiting")}
            </p>
            <Button variant="ghost" className="self-start" onClick={() => void copyCode()}>
              {copied ? t("transfer.copied") : t("transfer.copy")}
            </Button>
          </div>
        )}
        {(inRoom || entries.length > 0) && (
          <TransferThread entries={entries} saves={saves} savedIds={savedIds} previews={previews} onAccept={acceptOffer} onReject={rejectOffer} onSave={saveReceived} />
        )}
        {phase === "failed" && (
          <div className="flex flex-wrap gap-2 py-3">
            <Button
              onClick={() => {
                const link = linkRef.current;
                link.finished = false;
                link.quiet = false;
                link.opened = false;
                link.control = "ready";
                link.activeId = null;
                forgetEnteredCode();
                clearStale();
                show("idle");
              }}
            >
              {t("transfer.again")}
            </Button>
            <Button variant="secondary" onClick={() => onUseCloud?.()}>
              {t("transfer.useCloud")}
            </Button>
          </div>
        )}
        {canDisconnect && !inRoom && !frameClassName && (
          <Button variant="ghost" className="self-start" onClick={userCancel}>
            {t("transfer.disconnect")}
          </Button>
        )}
        </div>
      </div>
      <div
        className={`border-t border-border bg-background pt-3 ${frameClassName}`}
        style={{ paddingBottom: `max(0.75rem, env(safe-area-inset-bottom), ${keyboard}px)` }}
      >
        {composerNode}
        {onAlsoCloud && (text.trim().length > 0 || files.length > 0) && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => onAlsoCloud()}>
            {alsoCloudLabel || t("transfer.alsoCloud")}
          </Button>
        )}
      </div>
    </section>
  );
}
