import { Download, Menu, RefreshCw, Search, Settings, WifiOff, X } from "lucide-react";
import { TelegramIcon } from "@/components/drop/telegram-icon";
import { TELEGRAM_URL } from "@/lib/links";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SendMode } from "@/components/drop/send-mode";
import { useLanOpenRequests } from "@/components/drop/lan-session-store";
import { DesktopShell, DriveNav, type HomeSurface, type Scope } from "@/components/drop/desktop-shell";
import { ALL_SCOPE, scopeLabel } from "@/components/drop/scope";
import { useScopeFallback } from "@/components/drop/use-scope-fallback";
import { HistoryPane } from "@/components/drop/history-pane";
import { useBackLayer } from "@/components/drop/use-back-layer";
import { PreviewStage } from "@/components/drop/preview-dialog";
import { SettingsDialog } from "@/components/drop/settings-dialog";
import { formatWhen } from "@/lib/drop/format";
import { applyTheme, useDropStore } from "@/lib/drop/store";
import { useI18n } from "@/lib/i18n";
import type { DropRecord } from "@/lib/drop/types";
import { modeForTransferSearch } from "@/lib/transfer/panel-flow";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type ShareSeed = { key: number; text: string; files: File[] };

export function DropApp() {
  const hydrate = useDropStore((state) => state.hydrate);
  const hydrated = useDropStore((state) => state.hydrated);
  const settings = useDropStore((state) => state.settings);
  const sync = useDropStore((state) => state.sync);
  const syncing = useDropStore((state) => state.syncing);
  const syncError = useDropStore((state) => state.syncError);
  const dismissSyncError = useDropStore((state) => state.dismissSyncError);
  const online = useDropStore((state) => state.online);
  const setOnline = useDropStore((state) => state.setOnline);
  const openSettings = useDropStore((state) => state.openSettings);
  const settingsOpen = useDropStore((state) => state.settingsOpen);
  const lastSyncAt = useDropStore((state) => state.lastSyncAt);
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  // Connecting or disconnecting a drive restarts the sync loop below, so it syncs at once.
  const googleOn = Boolean(google);
  const microsoftOn = Boolean(microsoft);
  const openPreview = useDropStore((state) => state.openPreview);
  const closePreview = useDropStore((state) => state.closePreview);
  const setQuery = useDropStore((state) => state.setQuery);
  const setKindFilter = useDropStore((state) => state.setKindFilter);
  const setProviderFilter = useDropStore((state) => state.setProviderFilter);
  const setDateFilter = useDropStore((state) => state.setDateFilter);
  const selecting = useDropStore((state) => state.selecting);
  const setSelecting = useDropStore((state) => state.setSelecting);
  const items = useDropStore((state) => state.items);
  const shelves = useDropStore((state) => state.shelves);
  const [layout, setLayout] = useState<"desktop" | "mobile" | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"preview" | null>(null);
  // Phone search is a full-screen layer of its own, so the detail sheet can open on top of it.
  const [searching, setSearching] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [scope, setScope] = useState<Scope>(ALL_SCOPE);
  useScopeFallback(scope, setScope);
  const [surface, setSurface] = useState<HomeSurface>("inbox");
  const [seed, setSeed] = useState<ShareSeed | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const { t } = useI18n();
  // The update check below runs for the app's lifetime; it reads the current language from here.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useLayoutEffect(() => {
    if (modeForTransferSearch(window.location.search) === "direct") setSurface("lan");
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const apply = () => setLayout(media.matches ? "desktop" : "mobile");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    applyTheme(settings.theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      if (useDropStore.getState().settings.theme === "system") applyTheme("system");
    };
    media.addEventListener("change", onTheme);
    return () => media.removeEventListener("change", onTheme);
  }, [hydrated, settings.theme]);

  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void sync();
    };
    const onOnline = () => {
      setOnline(true);
      void sync();
    };
    const onOffline = () => setOnline(false);
    const onVis = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const timer = window.setInterval(tick, 25_000);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVis);
    void sync();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hydrated, sync, setOnline, googleOn, microsoftOn]);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  // A phone PWA can sit in the background for days with the old bundle in memory, so a deploy
  // only shows up after a real reload. When the app comes back to the foreground, compare the
  // entry script of the live page with the one this tab booted from and offer a one-tap refresh.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const booted = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src;
    if (!booted) return;
    const entry = new URL(booted, location.href).pathname;
    let lastCheck = Date.now();
    let offered = false;
    const check = async () => {
      if (offered || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - lastCheck < 30_000) return;
      lastCheck = Date.now();
      void navigator.serviceWorker
        ?.getRegistration()
        .then((registration) => registration?.update())
        .catch(() => undefined);
      try {
        const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
        if (!response.ok) return;
        const live = (await response.text()).match(/<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/)?.[1];
        if (!live || live === entry || offered) return;
        offered = true;
        const tr = tRef.current;
        toast(tr("update.title"), {
          description: tr("update.body"),
          duration: Infinity,
          action: { label: tr("update.action"), onClick: () => location.reload() },
        });
      } catch {
        // Offline or a flaky network: try again next time the app comes back.
      }
    };
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(onVisible, 10 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (layout === "mobile") setSearching(true);
        else window.dispatchEvent(new Event("droprevive-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout]);

  useEffect(() => {
    let cancel = false;
    const take = (text: string, files: File[]) => {
      if (cancel) return;
      setSeed({ key: Date.now(), text, files });
    };
    const params = new URLSearchParams(window.location.search);
    const sharedText = [params.get("title"), params.get("text"), params.get("url")].filter(Boolean).join("\n");
    if (params.get("shared") === "1" || sharedText) {
      void readSharedCache(sharedText).then((shared) => {
        take(shared.text, shared.files);
        window.history.replaceState(null, "", "/");
      });
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; text?: string; files?: File[] } | null;
      if (data?.type !== "droprevive-share") return;
      take(data.text || "", data.files || []);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    const queue = (window as Window & { launchQueue?: { setConsumer: (cb: (launch: { files: Array<{ getFile: () => Promise<File> }> }) => void) => void } }).launchQueue;
    queue?.setConsumer((launch) => {
      void Promise.all(launch.files.map((handle) => handle.getFile())).then((files) => take("", files));
    });
    return () => {
      cancel = true;
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) setDrawer(false);
  }, [settingsOpen]);

  const connected = Boolean(google || microsoft);

  function selectInbox(next: Scope) {
    setSurface("inbox");
    setScope(next);
    setSelecting(false);
    setDrawer(false);
  }

  // Mobile only: on desktop, DesktopShell answers these itself.
  useLanOpenRequests(() => {
    if (layout !== "desktop") selectLan();
  });

  function selectLan() {
    setSurface("lan");
    setSelecting(false);
    setDrawer(false);
  }

  function openItem(item: DropRecord) {
    setActiveId(item.id);
    void openPreview(item);
    if (layout === "mobile") setSheet("preview");
  }

  function closeItem() {
    setActiveId(null);
    closePreview();
    setSheet(null);
  }

  function closeSearch() {
    setSearching(false);
    // The phone home list has no search field or filter menu, so don't leave it silently filtered.
    setQuery("");
    setKindFilter("all");
    setProviderFilter("all");
    setDateFilter("all");
    setSelecting(false);
  }

  // Phone / browser Back gesture and Esc close the top layer: the detail sheet first, then multi-select, then search.
  useBackLayer(layout === "mobile" && searching, closeSearch);
  useBackLayer(layout === "mobile" && selecting, () => setSelecting(false));
  useBackLayer(layout === "mobile" && sheet === "preview", () => setSheet(null));

  if (!layout) return <div className="h-dvh bg-background" />;

  return (
    <div className="flex h-dvh w-full max-w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Phone top bar, one row: menu, then the page title (drive / folder, or LAN), then search and sync on the right.
          The device name lives in the drawer and in settings. */}
      <header
        className={`${layout === "desktop" ? "hidden" : "flex"} items-center gap-1 px-4 ${
          surface === "lan" ? "pt-[max(0.25rem,env(safe-area-inset-top))] pb-1" : "pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
        }`}
      >
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 shrink-0"
          aria-label={t("nav.openSidebar")}
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          <Menu className="size-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-foreground">
          {surface === "lan" ? t("nav.lan") : scopeLabel(scope, shelves)}
        </h2>
        {surface !== "lan" && items.length >= 6 && !selecting && (
          <Button variant="ghost" size="icon" className="shrink-0" aria-label={t("nav.search")} onClick={() => setSearching(true)}>
            <Search className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="-mr-2 shrink-0" aria-label={t("nav.sync")} onClick={() => void sync(true)} disabled={syncing}>
          <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
        </Button>
      </header>

      {layout === "mobile" && surface !== "lan" && !connected && (
        <button
          type="button"
          className="flex h-10 w-full items-center justify-center border-t border-border bg-muted text-sm"
          onClick={openSettings}
        >
          {t("nav.connectDrive")}
        </button>
      )}
      {layout === "mobile" && !online && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm" role="status">
          <WifiOff className="size-4 shrink-0" />
          {t("nav.offlineBanner")}
        </div>
      )}
      {layout === "mobile" && surface === "inbox" && online && syncError && (
        <div className="mx-4 mb-2 flex items-start justify-between gap-3 rounded-xl bg-muted px-3 py-2 text-sm" role="alert">
          <p>{syncError}</p>
          <button type="button" className="shrink-0 underline" onClick={dismissSyncError}>
            {t("nav.dismiss")}
          </button>
        </div>
      )}

      {layout === "desktop" ? (
        <DesktopShell seed={seed} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
          {surface === "lan" ? (
            <div className="flex min-h-0 flex-1 flex-col px-4">
                <SendMode
                  compact
                  mode="lan"
                  seed={null}
                  scope={scope}
                  onLeaveToInbox={() => selectInbox(scope)}
                />
            </div>
          ) : (
            <HistoryPane activeId={activeId} layout="mobile" scope={scope} heading={false} onOpen={openItem} />
          )}
          <div
            className={
              // Multi-select puts its action bar where the composer was.
              surface === "lan" || selecting
                ? "hidden"
                : "border-t border-border bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            }
          >
            <SendMode compact mode="inbox" seed={seed} scope={scope} />
          </div>
        </div>
      )}

      {layout === "mobile" && (
        <div className={`fixed inset-0 z-30 ${drawer ? "" : "pointer-events-none"}`} inert={!drawer}>
          {/* Scrim over the strip the drawer leaves uncovered; tapping it closes the drawer. Black in both themes so dark mode dims instead of washing out. */}
          <div
            aria-hidden="true"
            className={`absolute inset-0 bg-black/40 transition-opacity duration-200 dark:bg-black/50 ${drawer ? "opacity-100" : "opacity-0"}`}
            onClick={() => setDrawer(false)}
          />
          {/* 80% of the screen, at most 320px; the page stays visible under the scrim on the right. */}
          <aside
            role="dialog"
            aria-label={t("nav.sidebar")}
            className={`absolute inset-y-0 left-0 flex w-4/5 max-w-[320px] flex-col border-r border-border bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-transform duration-200 ${
              drawer ? "translate-x-0 shadow-xl" : "-translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between gap-2 py-3 pl-5 pr-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">DropRevive</p>
                <p className="truncate text-xs text-muted-foreground">{settings.deviceName || t("device.this")}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label={t("nav.closeSidebar")} onClick={() => setDrawer(false)}>
                <X className="size-4" />
              </Button>
            </div>
            <DriveNav stackStatus className="pl-5 pr-2" scope={scope} surface={surface} onScope={selectInbox} onLan={selectLan} />
            <div className="border-t border-border py-2 pl-5 pr-2">
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {syncing ? t("nav.syncing") : syncError ? syncError : lastSyncAt ? t("nav.lastSync", { when: formatWhen(new Date(lastSyncAt).toISOString()) }) : t("nav.neverSynced")}
                </p>
                <Button variant="ghost" size="icon" aria-label={t("nav.sync")} onClick={() => void sync(true)} disabled={syncing}>
                  <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                </Button>
              </div>
              <div className="flex flex-nowrap items-center gap-0.5">
                <Button variant="ghost" size="sm" className="justify-start px-2" onClick={openSettings}>
                  <Settings className="size-4" />
                  {t("nav.settingsShort")}
                </Button>
                <Button variant="ghost" size="sm" className="justify-start px-2" asChild>
                  <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label={t("nav.telegram")} title={t("nav.telegram")}>
                    <TelegramIcon className="size-4" />
                    {t("nav.telegramShort")}
                  </a>
                </Button>
                {installEvent && (
                  <Button variant="ghost" size="sm" className="px-2" onClick={() => void installEvent.prompt().then(() => setInstallEvent(null))}>
                    <Download className="size-4" />
                    {t("nav.install")}
                  </Button>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {layout === "mobile" && searching && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("history.searchLabel")}
          className="fixed inset-0 z-30 flex flex-col bg-background pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
        >
          <HistoryPane activeId={activeId} layout="mobile" onBack={closeSearch} onOpen={openItem} />
        </div>
      )}

      {layout === "mobile" && sheet && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-foreground/40" onClick={() => setSheet(null)}>
          <div
            className="flex max-h-[85dvh] flex-col overflow-hidden rounded-t-3xl bg-background pt-4 pr-1.5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="scrollbar-pill min-h-0 overflow-y-auto pr-2.5 pb-[max(1rem,env(safe-area-inset-bottom))] pl-4">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
              {sheet === "preview" && (
                <PreviewStage
                  onClose={() => setSheet(null)}
                  onDeleted={closeItem}
                />
              )}
            </div>
          </div>
        </div>
      )}

      <SettingsDialog />
    </div>
  );
}

async function readSharedCache(fallback: string): Promise<{ text: string; files: File[] }> {
  if (!("caches" in window)) return { text: fallback, files: [] };
  const cache = await caches.open("droprevive-share");
  const keys = await cache.keys();
  const files: File[] = [];
  for (const key of keys) {
    if (!key.url.includes("/share-file/")) continue;
    const response = await cache.match(key);
    if (!response) continue;
    const name = decodeURIComponent(response.headers.get("x-file-name") || "file");
    const blob = await response.blob();
    files.push(new File([blob], name, { type: blob.type || "application/octet-stream" }));
    await cache.delete(key);
  }
  const stored = await cache.match("/share-text");
  const text = stored ? await stored.text() : fallback;
  if (stored) await cache.delete("/share-text");
  return { text: text || fallback, files };
}
