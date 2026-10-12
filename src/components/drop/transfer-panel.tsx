import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import QRCode from "qrcode";
import { Flashlight, FlashlightOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TransferThread, type ThreadFile } from "@/components/drop/transfer-thread";
import { linkChipClass } from "@/components/drop/link-chip";
import { lanSession, useLan } from "@/components/drop/lan-session-store";
import { useI18n } from "@/lib/i18n";
import { isRoomCode } from "@/lib/transfer/code";
import { ownedBuffer } from "@/lib/transfer/lan-session";
import { stopMedia } from "@/lib/transfer/link";
import { createJsqrDecoder, createNativeDecoder, createScanEngine, formatDebug, grabFrame, judgeScan, NOTHING_READ_MS, scanErrorKey, describeError, type Decoder, type JsQr } from "@/lib/transfer/scan-decode";
import { cameraConstraints, prepareCamera, setTorch, supportsPointsOfInterest, tapFocus, tapPoint, viewfinderAspect } from "@/lib/transfer/scan-camera";
import { withoutTransferSearch } from "@/lib/transfer/panel-flow";
import { linkVisual, offerBlocked, sessionVisible, stickToEnd } from "@/lib/transfer/timeline";

type Saveable = ThreadFile;

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>> };
type DetectorCtor = (new (options?: { formats?: string[] }) => Detector) & { getSupportedFormats?: () => Promise<string[]> };

async function loadJsqrDecoder(): Promise<Decoder<HTMLVideoElement>> {
  const mod = await import("jsqr");
  const canvas = document.createElement("canvas");
  return createJsqrDecoder<HTMLVideoElement>(mod.default as JsQr, (video) => grabFrame(video, canvas));
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
  onAlsoCloud?: () => void;
  onClearDraft?: () => void;
  alsoCloudLabel?: string;
  composer: ReactElement<{ hideSend?: boolean; directSend?: { label: string; disabled?: boolean; onSend: () => void } }>;
}) {
  const { t } = useI18n();
  // The session (room, link, timeline) belongs to the tab, not to this panel: see lan-session-store.
  const session = lanSession();
  const phase = useLan((state) => state.phase);
  const note = useLan((state) => state.note);
  const noteKey = useLan((state) => state.noteKey);
  const entries = useLan((state) => state.entries);
  const code = useLan((state) => state.code);
  const peerName = useLan((state) => state.peerName);
  const saves = useLan((state) => state.saves);
  const savedIds = useLan((state) => state.savedIds);
  const previews = useLan((state) => state.previews);
  const mountedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [keyboard, setKeyboard] = useState(0);
  const [entry, setEntry] = useState("");
  const [qr, setQr] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
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
    mountedRef.current = true;
    session.setPanelOpen(true);
    return () => {
      // Leaving the LAN page only closes the camera; the session keeps running.
      mountedRef.current = false;
      session.setPanelOpen(false);
      window.clearTimeout(loopRef.current);
      stopMedia(session.link());
    };
  }, [session]);

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

  function stopScanner() {
    window.clearTimeout(loopRef.current);
    loopRef.current = 0;
    stopMedia(session.link());
    setScanning(false);
  }

  async function scan() {
    lastOtherHostRef.current = "";
    setDebugText("");
    lastRawRef.current = "";
    lastOutcomeRef.current = "";
    setDebugOn(new URLSearchParams(window.location.search).get("scandebug") === "1");
    if (!navigator.mediaDevices?.getUserMedia) {
      session.idleNote(t("transfer.scanMissing"));
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
      const link = session.link();
      if (!mountedRef.current) {
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
        session.idleNote(t("transfer.scanNoDecoder"));
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
          session.idleNote(t("transfer.scanNoDecoder"));
          return;
        }
        for (const raw of result.raws) {
          lastRawRef.current = raw;
          const outcome = judgeScan(raw, window.location.origin);
          lastOutcomeRef.current = outcome.kind === "ok" ? `yes (${outcome.code})` : outcome.kind === "other-site" ? `no: other site ${outcome.host}` : `no: ${outcome.kind}`;
          if (outcome.kind === "ok") {
            stopScanner();
            join(outcome.code);
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
      session.idleNote(t(scanErrorKey(error)));
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

  function join(raw: string) {
    if (isRoomCode(raw.trim().toUpperCase())) {
      forgetEnteredCode();
      stopMedia(session.link());
      setScanning(false);
    }
    void session.join(raw);
  }

  function userCancel() {
    const unsaved = session.unsavedCount();
    if (unsaved > 0 && !window.confirm(t("transfer.disconnectUnsaved", { count: unsaved }))) return;
    setScanning(false);
    session.disconnect();
  }

  function offerCurrent() {
    if (session.offer(text, files)) onClearDraft?.();
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

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
      if (saved) session.markSaved(file.id);
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
            <Button onClick={() => void session.createRoom()}>{t("transfer.create")}</Button>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                join(entry);
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
          <TransferThread entries={entries} saves={saves} savedIds={savedIds} previews={previews} onAccept={session.accept} onReject={session.reject} onSave={saveReceived} onDismiss={session.dismiss} />
        )}
        {phase === "failed" && (
          <div className="flex flex-wrap gap-2 py-3">
            <Button
              onClick={() => {
                forgetEnteredCode();
                session.retry();
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
