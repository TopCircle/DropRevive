import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { Cloud, Inbox, PanelLeft, Plus, Radio, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SendMode } from "@/components/drop/send-mode";
import { CopyText } from "@/components/drop/copy-text";
import { LanBadge } from "@/components/drop/lan-badge";
import { useLanOpenRequests } from "@/components/drop/lan-session-store";
import { PreviewStage } from "@/components/drop/preview-dialog";
import { useLongPress } from "@/components/drop/use-long-press";
import { OverlayScrollbar } from "@/components/drop/overlay-scrollbar";
import { Button } from "@/components/ui/button";
import { googleConfigured, microsoftConfigured } from "@/lib/drop/client-env";
import { formatWhen } from "@/lib/drop/format";
import { useI18n } from "@/lib/i18n";
import { itemBlob, mimeOf, useDropStore } from "@/lib/drop/store";
import { cn } from "@/lib/utils";
import { searchInView, viewKey, viewResults, type DesktopSearch } from "@/lib/drop/desktop-search";
import type { DropRecord, ProviderId, Scope } from "@/lib/drop/types";
import { modeForTransferSearch } from "@/lib/transfer/panel-flow";
import { useScopeFallback } from "@/components/drop/use-scope-fallback";
import { ALL_SCOPE, scopeLabel } from "@/components/drop/scope";
import { TelegramIcon } from "@/components/drop/telegram-icon";
import { TELEGRAM_URL } from "@/lib/links";
import { oldestFirst, ownNewestKey, useStickToBottom } from "@/components/drop/use-stick-to-bottom";

export type HomeSurface = "inbox" | "lan";

export type { Scope };

/** Moves an item within its own drive(s): to another subfolder or back to the DropRevive root; sync moves the files. */
export function FolderPicker({ itemId, className = "" }: { itemId: string; className?: string }) {
  const item = useDropStore((state) => state.items.find((entry) => entry.id === itemId));
  const shelves = useDropStore((state) => state.shelves);
  const moveItem = useDropStore((state) => state.moveItem);
  const { t } = useI18n();
  if (!item?.refs.length) return null;
  const drives = [...new Set(item.refs.map((ref) => ref.provider))];
  const current = drives.map((drive) => item.folders?.[drive]);
  const inFolder = current.some(Boolean);
  // Only folders present on every drive holding the item, so a move never reaches another drive.
  const names = [...new Set(shelves.filter((shelf) => shelf.state !== "removed").map((shelf) => shelf.id))].filter(
    (name) =>
      !current.every((folder) => folder === name) &&
      drives.every((drive) => shelves.some((shelf) => shelf.id === name && shelf.provider === drive && shelf.state !== "removed")),
  );
  if (!inFolder && !names.length) return null;
  return (
    <select
      aria-label={t("nav.moveToFolder")}
      value=""
      onChange={(event) => moveItem(item.id, event.target.value === ROOT ? null : event.target.value)}
      className={cn("h-8 max-w-40 rounded-lg bg-muted px-2 text-xs text-muted-foreground outline-none", className)}
    >
      <option value="" disabled>
        {t("nav.moveToFolderPrompt")}
      </option>
      {inFolder && <option value={ROOT}>{t("nav.rootFolder")}</option>}
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

const ROOT = "\u0000root";

/**
 * Click/keyboard props for a text block that acts like a button but keeps its text
 * selectable (a real <button> can't be drag- or long-press-selected). A click that ends
 * a text selection is ignored, so selecting part of a message to copy it doesn't act.
 */
function tapProps(act: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: () => {
      if (!window.getSelection()?.toString()) act();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      act();
    },
  } as const;
}

const THUMB_MAX = 10 * 1024 * 1024;

function isThumb(item: DropRecord): boolean {
  return item.kind === "file" && item.size <= THUMB_MAX && mimeOf(item).startsWith("image/");
}

/**
 * Image item thumbnail: fetches the file (IndexedDB cache first) once it scrolls near
 * the viewport, shows a placeholder meanwhile and nothing on failure, so the filename
 * bubble is what's left.
 */
export function Thumb({ item, className = "", onOpen }: { item: DropRecord; className?: string; onOpen?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  const blobId = item.refs.find((ref) => ref.blobId)?.blobId;
  const imageName = item.fileName || t("bubble.image");
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    let objectUrl: string | null = null;
    let live = true;
    setFailed(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        itemBlob(item).then(
          (blob) => {
            if (!live) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          },
          () => live && setFailed(true),
        );
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the file itself changes
  }, [item.id, blobId]);
  if (failed) return null;
  return (
    <div
      ref={box}
      className={`overflow-hidden rounded-xl bg-muted ${url ? "" : "h-40 animate-pulse"} ${onOpen ? "cursor-pointer" : ""} ${className}`}
      {...(onOpen ? tapProps(onOpen) : {})}
      aria-label={onOpen ? t("bubble.previewImage", { name: imageName }) : undefined}
    >
      {url && <img src={url} alt={imageName} className="block max-h-60 w-full object-cover" onError={() => setFailed(true)} />}
    </div>
  );
}

/** Delete with a confirm step; the store trashes the cloud copies first, so other devices drop it on their next sync. */
export function DeleteItem({
  itemId,
  className = "",
  children,
  onDeleted,
}: {
  itemId: string;
  className?: string;
  children?: ReactNode;
  onDeleted?: () => void;
}) {
  const remove = useDropStore((state) => state.remove);
  const { t } = useI18n();
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <button type="button" aria-label={t("delete.confirm")} className={cn("inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg text-subtle hover:text-danger", className)}>
          {children ?? <Trash2 className="size-4" />}
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-card p-5">
          <AlertDialog.Title className="text-lg font-medium">{t("delete.oneTitle")}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
            {t("delete.body")}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{t("delete.cancel")}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                onClick={() =>
                  void remove([itemId]).then(
                    () => {
                      toast.success(t("delete.done"));
                      onDeleted?.();
                    },
                    (error: unknown) => toast.error(error instanceof Error ? error.message : t("delete.failed")),
                  )
                }
              >
                {t("delete.confirm")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Shared by heading, message list and composer so their edges line up (chat-app width). */
const COLUMN = "mx-auto w-full max-w-[56rem] px-8";

/** Border-box height of an overlay, kept current (0 while hidden). */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setHeight(Math.ceil(node.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

export function DesktopShell({
  seed,
}: {
  seed: { key: number; text: string; files: File[] } | null;
}) {
  const settings = useDropStore((state) => state.settings);
  const items = useDropStore((state) => state.items);
  const shelves = useDropStore((state) => state.shelves);
  const openSettings = useDropStore((state) => state.openSettings);
  const sync = useDropStore((state) => state.sync);
  const syncing = useDropStore((state) => state.syncing);
  const download = useDropStore((state) => state.download);
  const syncError = useDropStore((state) => state.syncError);
  const preview = useDropStore((state) => state.preview);
  const openPreview = useDropStore((state) => state.openPreview);
  const closePreview = useDropStore((state) => state.closePreview);
  const { t } = useI18n();
  const [scope, setScope] = useState<Scope>(ALL_SCOPE);
  useScopeFallback(scope, setScope);
  const [surface, setSurface] = useState<HomeSurface>("inbox");
  const [rail, setRail] = useState<"expanded" | "collapsed">("expanded");
  const pinned = useRef(false);
  // Search inside the current view only. It belongs to the view it was typed in, so another
  // drive / folder / 全部 starts empty (searchInView), and the LAN page has none.
  const [searchState, setSearch] = useState<DesktopSearch>({ open: false, query: "", view: viewKey(ALL_SCOPE) });
  const view = viewKey(scope);
  const search = searchInView(searchState, view);
  const searchOpen = surface === "inbox" && search.open;
  const query = searchOpen ? search.query : "";
  const searchRef = useRef<HTMLInputElement>(null);
  // Commit the switch, so going back to the previous folder doesn't bring its query back.
  useLayoutEffect(() => {
    setSearch((current) => searchInView(current, view));
  }, [view]);
  const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";

  // Bumped on every open request, so Ctrl/⌘+K also refocuses a field that is already open.
  const [focusTick, setFocusTick] = useState(0);
  function openSearch() {
    setSearch((current) => ({ ...searchInView(current, view), open: true }));
    setFocusTick((tick) => tick + 1);
  }
  useEffect(() => {
    if (!searchOpen || !focusTick) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchOpen, focusTick]);

  /** × and Esc: first drop the text, then close. */
  function stepBackSearch() {
    setSearch((current) => {
      const now = searchInView(current, view);
      return now.query ? { ...now, query: "" } : { ...now, open: false };
    });
  }

  // Ctrl/⌘+K (drop-app turns it into this event on desktop) opens or refocuses the field.
  useEffect(() => {
    const onSearch = () => {
      if (surface === "inbox") openSearch();
    };
    window.addEventListener("droprevive-search", onSearch);
    return () => window.removeEventListener("droprevive-search", onSearch);
  });

  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog on top (preview, settings, delete confirm) takes Esc for itself.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      stepBackSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useLayoutEffect(() => {
    if (modeForTransferSearch(window.location.search) === "direct") setSurface("lan");
  }, []);

  useLanOpenRequests(() => {
    setSurface("lan");
    setSearch((current) => ({ ...current, open: false, query: "" }));
  });

  function selectInbox(next: Scope) {
    setSurface("inbox");
    setScope(next);
  }

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1280px)");
    const apply = () => {
      if (pinned.current) return;
      setRail(wide.matches ? "expanded" : "collapsed");
    };
    apply();
    wide.addEventListener("change", apply);
    return () => wide.removeEventListener("change", apply);
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const headerHeight = useHeight(headerRef);
  const composerHeight = useHeight(composerRef);
  const stream = oldestFirst(viewResults(items, scope, query));
  const filtering = query.trim().length > 0;
  const { scrollRef, contentRef } = useStickToBottom({
    resetKey: `${surface}/${scope.provider}/${scope.shelfId ?? ""}/${query}`,
    jumpKey: ownNewestKey(stream, settings.deviceId),
    count: stream.length,
  });

  function toggleRail() {
    pinned.current = true;
    setRail((current) => (current === "expanded" ? "collapsed" : "expanded"));
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`flex shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 ${
          rail === "expanded" ? "w-60" : "w-14"
        }`}
      >
        {rail === "collapsed" ? (
          <div className="flex flex-col items-center gap-1 px-2 py-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground" aria-hidden="true">
              <Inbox className="size-4" />
            </span>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              aria-label={t("nav.expand")}
              onClick={toggleRail}
            >
              <PanelLeft className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-2 py-3">
            <div className="min-w-0 px-1">
              <p className="truncate text-sm font-medium">DropRevive</p>
              <p className="truncate text-xs text-muted-foreground">{settings.deviceName || t("device.this")}</p>
            </div>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              aria-label={t("nav.collapse")}
              onClick={toggleRail}
            >
              <PanelLeft className="size-4" />
            </button>
          </div>
        )}

        <DriveNav
          collapsed={rail === "collapsed"}
          scope={scope}
          surface={surface}
          onScope={selectInbox}
          onLan={() => {
            setSurface("lan");
            setSearch((current) => ({ ...current, open: false, query: "" }));
          }}
          onExpand={() => {
            if (rail !== "collapsed") return;
            pinned.current = true;
            setRail("expanded");
          }}
        />

        <div className={`flex gap-1 border-t border-border p-2 ${rail === "expanded" ? "" : "flex-col items-center"}`}>
          <Button variant="ghost" size="icon" aria-label={t("nav.sync")} onClick={() => void sync(true)} disabled={syncing}>
            <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("nav.settings")} onClick={openSettings}>
            <Settings className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" asChild>
            <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label={t("nav.telegram")} title={t("nav.telegram")}>
              <TelegramIcon className="size-5" />
            </a>
          </Button>
        </div>
      </aside>

      {/* The stream scrolls under a translucent title bar and the composer, across the whole pane height, with a
          thin overlay thumb on the window edge (OverlayScrollbar); spacers keep the first / last item clear of both. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {surface === "lan" && (
          <SendMode frameClassName={COLUMN} mode="lan" seed={null} scope={scope} onLeaveToInbox={() => selectInbox(scope)} />
        )}
        {/* Stay mounted while LAN is open so a cloud draft is still there when the user comes back. */}
        <div className={surface === "inbox" ? "relative min-h-0 flex-1" : "hidden"}>
          <div ref={scrollRef} data-timeline="" className="scrollbar-hidden absolute inset-0 overflow-y-auto">
            <div ref={contentRef} className={`${COLUMN} flex flex-col gap-1`}>
              <div aria-hidden="true" className="shrink-0" style={{ height: headerHeight }} />
              {stream.length === 0 ? (
                <p className="px-1 pt-6 text-sm text-muted-foreground">
                  {filtering ? t("desktopSearch.empty", { scope: scopeLabel(scope, shelves), query: query.trim() }) : t("empty.desktop")}
                </p>
              ) : (
                stream.map((item) => <Bubble key={item.id} item={item} onDownload={download} onPreview={(entry) => void openPreview(entry)} />)
              )}
              <div aria-hidden="true" className="shrink-0" style={{ height: composerHeight }} />
            </div>
          </div>
          {/* Only the controls take the pointer, so the wheel over the bar's empty parts still scrolls the stream. */}
          <div ref={headerRef} data-stream-header="" className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-background/85 backdrop-blur-md">
            <div className={COLUMN}>
              <div className="relative flex items-center justify-center py-3">
                <h2 className="truncate px-10 text-center text-lg font-semibold text-foreground">{scopeLabel(scope, shelves)}</h2>
                <button
                  type="button"
                  className={`pointer-events-auto absolute right-0 inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted ${searchOpen ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  aria-label={t("desktopSearch.open")}
                  title={`${t("desktopSearch.open")}（${shortcut}）`}
                  aria-expanded={searchOpen}
                  onClick={openSearch}
                >
                  <Search className="size-4" />
                </button>
              </div>
              {searchOpen && (
                <div role="search" className="pointer-events-auto mb-2 flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 focus-within:border-foreground/30">
                  <Search className="size-4 shrink-0 text-subtle" />
                  <input
                    ref={searchRef}
                    type="search"
                    value={search.query}
                    onChange={(event) => setSearch({ open: true, query: event.target.value, view })}
                    placeholder={t("desktopSearch.placeholder", { scope: scopeLabel(scope, shelves) })}
                    aria-label={t("desktopSearch.placeholder", { scope: scopeLabel(scope, shelves) })}
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
                  />
                  {filtering && (
                    <span className="shrink-0 text-xs text-subtle" aria-live="polite">
                      {t("desktopSearch.count", { count: stream.length })}
                    </span>
                  )}
                  <button
                    type="button"
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                    aria-label={search.query ? t("history.clearQuery") : t("history.closeSearch")}
                    title="Esc"
                    onClick={() => {
                      stepBackSearch();
                      searchRef.current?.focus();
                    }}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}
              {syncError && (
                <p role="alert" className="pb-2 text-center text-xs text-danger">
                  {syncError}
                </p>
              )}
            </div>
          </div>
          <div ref={composerRef} data-stream-composer="" className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-background from-70% to-transparent pt-8">
            <div className={`${COLUMN} pb-5`}>
              <div className="pointer-events-auto">
                <SendMode mode="inbox" seed={seed} scope={scope} />
              </div>
            </div>
          </div>
          <OverlayScrollbar scrollRef={scrollRef} />
        </div>
      </div>
      <Dialog.Root open={Boolean(preview)} onOpenChange={(open) => !open && closePreview()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-card py-5 pr-1.5"
          >
            <Dialog.Title className="sr-only">{t("preview.title")}</Dialog.Title>
            <div className="scrollbar-pill min-h-0 overflow-y-auto pr-3.5 pl-5">
              <PreviewStage onClose={closePreview} onDeleted={closePreview} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** Provider rows (connect status + folders) and the "全部" filter; shared by the desktop rail and the mobile drawer. */
export function DriveNav({
  collapsed = false,
  stackStatus = false,
  className,
  scope,
  surface,
  onScope,
  onLan,
  onExpand,
}: {
  collapsed?: boolean;
  stackStatus?: boolean;
  className?: string;
  scope: Scope;
  surface: HomeSurface;
  onScope: (scope: Scope) => void;
  onLan: () => void;
  onExpand?: () => void;
}) {
  const shelves = useDropStore((state) => state.shelves);
  const addShelf = useDropStore((state) => state.addShelf);
  const removeShelf = useDropStore((state) => state.removeShelf);
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  const openSettings = useDropStore((state) => state.openSettings);
  const { t } = useI18n();
  const [naming, setNaming] = useState<ProviderId | null>(null);
  const [folderName, setFolderName] = useState("");

  function createFolder(provider: ProviderId) {
    const name = folderName.trim();
    if (!name) return;
    addShelf(provider, name);
    setFolderName("");
    setNaming(null);
  }

  return (
    <div className={cn("scrollbar-pill min-h-0 flex-1 overflow-y-auto px-2", className)}>
      {!collapsed && <p className="px-2 pb-1 text-xs text-subtle">{t("nav.drives")}</p>}
      {(["google", "microsoft"] as const).map((id) => {
        const on = Boolean(id === "google" ? google : microsoft);
        return (
          <DriveBlock
            key={id}
            id={id}
            collapsed={collapsed}
            on={on}
            stackStatus={stackStatus}
            account={id === "google" ? google?.email : microsoft?.username}
            active={surface === "inbox" && scope.provider === id && !scope.shelfId}
            shelves={shelves.filter((shelf) => shelf.provider === id && shelf.state !== "removed")}
            activeShelf={surface === "inbox" && scope.provider === id ? scope.shelfId : null}
            naming={naming === id}
            folderName={folderName}
            onOpen={() => {
              if (!on) {
                openSettings();
                return;
              }
              onScope({ provider: id, shelfId: null });
              onExpand?.();
            }}
            onShelf={(shelfId) => onScope({ provider: id, shelfId })}
            onStartName={() => {
              setNaming(id);
              setFolderName("");
            }}
            onName={setFolderName}
            onCreate={() => createFolder(id)}
            onCancel={() => setNaming(null)}
            onRemove={(shelfId) => removeShelf(id, shelfId)}
          />
        );
      })}
      {!collapsed && (
        <button
          type="button"
          className={`mt-1 w-full rounded-lg px-2 py-1.5 text-left text-sm ${surface === "inbox" && scope.provider === "all" ? "bg-muted" : "text-muted-foreground hover:bg-muted"}`}
          onClick={() => onScope(ALL_SCOPE)}
        >
          {t("nav.all")}
        </button>
      )}
      <div className={collapsed ? "mt-1" : "mt-3 border-t border-border pt-2"}>
        <button
          type="button"
          aria-label={t("nav.lan")}
          title={t("nav.lan")}
          aria-current={surface === "lan" ? "page" : undefined}
          className={
            collapsed
              ? `relative mx-auto mb-2 flex size-9 items-center justify-center rounded-lg ${surface === "lan" ? "bg-muted" : "hover:bg-muted"}`
              : `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${surface === "lan" ? "bg-muted" : "hover:bg-muted"}`
          }
          onClick={() => {
            onLan();
            onExpand?.();
          }}
        >
          <Radio className="size-4 shrink-0" />
          {!collapsed && t("nav.lan")}
          <LanBadge collapsed={collapsed} />
        </button>
      </div>
    </div>
  );
}

function DriveBlock({
  id,
  collapsed,
  on,
  stackStatus = false,
  account,
  active,
  shelves,
  activeShelf,
  naming,
  folderName,
  onOpen,
  onShelf,
  onStartName,
  onName,
  onCreate,
  onCancel,
  onRemove,
}: {
  id: ProviderId;
  collapsed: boolean;
  on: boolean;
  stackStatus?: boolean;
  account?: string;
  active: boolean;
  shelves: { id: string; name: string }[];
  activeShelf: string | null;
  naming: boolean;
  folderName: string;
  onOpen: () => void;
  onShelf: (id: string) => void;
  onStartName: () => void;
  onName: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const label = id === "google" ? "Google Drive" : "OneDrive";
  const configured = id === "google" ? googleConfigured : microsoftConfigured;
  const state = on ? "" : configured ? t("nav.notConnected") : t("nav.unavailable");
  if (collapsed) {
    return (
      <button
        type="button"
        title={on ? label : t("nav.driveTitle", { label, state })}
        aria-label={label}
        className={`relative mx-auto mb-2 flex size-9 items-center justify-center rounded-lg ${active ? "bg-muted" : "hover:bg-muted"}`}
        onClick={onOpen}
      >
        {id === "google" ? <GoogleDriveIcon /> : <Cloud className="size-5 text-[#0078D4]" />}
        <span className={`absolute right-1 bottom-1 size-1.5 rounded-full ${on ? "bg-ok" : "bg-border"}`} aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="mb-2">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${active ? "bg-muted" : "hover:bg-muted"}`}
          onClick={onOpen}
        >
          <span className={`size-2 rounded-full ${on ? "bg-ok" : "bg-border"}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {on && account && <span className="block truncate text-[11px] leading-4 text-subtle">{account}</span>}
            {stackStatus && !on && <span className="block text-xs text-subtle">{configured ? t("nav.connect") : state}</span>}
          </span>
          {!stackStatus && !on && <span className="shrink-0 text-xs text-subtle">{configured ? t("nav.connect") : state}</span>}
        </button>
        <button
          type="button"
          title={t("nav.newFolder")}
          aria-label={t("nav.newFolder")}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onStartName}
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="mt-0.5 ml-4 flex flex-col">
        {shelves.map((shelf) => (
          <div key={shelf.id} className={`group flex items-center rounded-lg pr-1 ${activeShelf === shelf.id ? "bg-muted" : "hover:bg-muted"}`}>
            <button type="button" className="min-w-0 flex-1 truncate px-2 py-1 text-left text-sm" onClick={() => onShelf(shelf.id)}>
              {shelf.name}
            </button>
            <button type="button" className="inline-flex size-6 items-center justify-center text-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100" aria-label={t("nav.deleteFolder", { name: shelf.name })} onClick={() => onRemove(shelf.id)}>
              <X className="size-3" />
            </button>
          </div>
        ))}
        {naming && (
          <form
            className="px-1 py-1"
            onSubmit={(event) => {
              event.preventDefault();
              onCreate();
            }}
          >
            <input
              autoFocus
              value={folderName}
              onChange={(event) => onName(event.target.value)}
              onBlur={onCancel}
              placeholder={t("nav.folderName")}
              className="h-8 w-full rounded-lg border border-border bg-card px-2 text-sm outline-none"
            />
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * The message bubble shared by the desktop stream and the phone list: shrinks to short
 * content, grows to the full column, image items show their thumbnail on top.
 */
export function BubbleCard({
  item,
  onTap,
  clamp = false,
  pressable = false,
  selected = false,
  onLongPress,
}: {
  item: DropRecord;
  onTap: () => void;
  clamp?: boolean;
  /** Phone list: long-press enters multi-select, so no text selection / callout on the bubble. */
  pressable?: boolean;
  selected?: boolean;
  onLongPress?: () => void;
}) {
  const { t } = useI18n();
  const press = useLongPress(pressable ? onLongPress : undefined);
  const title = item.kind === "text" ? item.text || t("bubble.text") : item.fileName || t("bubble.file");
  return (
    <div
      data-bubble=""
      aria-pressed={pressable ? selected : undefined}
      className={cn(
        "w-fit max-w-full min-w-0 cursor-pointer rounded-2xl border border-border bg-card px-3 py-2 text-left transition-colors",
        pressable ? "select-none [-webkit-touch-callout:none] [&_img]:pointer-events-none" : "select-text",
        selected && "border-foreground/40 bg-muted",
      )}
      {...tapProps(onTap)}
      {...(pressable ? press : {})}
    >
      {isThumb(item) && <Thumb item={item} className="mb-2 w-60 max-w-full" />}
      <p className={cn("wrap-anywhere whitespace-pre-wrap text-left text-sm leading-6", clamp && "line-clamp-8")}>{title}</p>
      <p className="mt-1 text-left text-[11px] text-subtle">
        {formatWhen(item.createdAt)} · {item.deviceName || t("bubble.unknownDevice")}
        {item.kind === "file" ? ` · ${t("bubble.file")}` : ""}
      </p>
    </div>
  );
}

function Bubble({
  item,
  onDownload,
  onPreview,
}: {
  item: DropRecord;
  onDownload: (item: DropRecord) => Promise<void>;
  onPreview: (item: DropRecord) => void;
}) {
  const { t } = useI18n();
  return (
    // Bubbles shrink to short content and grow to the full column; actions sit on a row below (shown on hover).
    <div className="group flex flex-col items-start">
      <BubbleCard
        item={item}
        onTap={() => {
          if (item.kind === "text" && item.text) {
            void navigator.clipboard.writeText(item.text).then(
              () => toast.success(t("bubble.copied")),
              () => toast.error(t("bubble.copyFailed")),
            );
            return;
          }
          if (isThumb(item)) return onPreview(item);
          void onDownload(item).catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : t("bubble.downloadFailed"));
          });
        }}
      />
      <div className="flex min-h-8 flex-wrap items-center gap-1">
        {item.kind === "text" && item.text && <CopyText text={item.text} />}
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <FolderPicker itemId={item.id} className="h-7" />
          <DeleteItem itemId={item.id} className="h-7 min-w-7" />
        </div>
      </div>
    </div>
  );
}

function GoogleDriveIcon() {
  return (
    <svg viewBox="0 0 87.3 78" className="size-5" aria-hidden="true">
      <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" />
      <path fill="#ea4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H58.2l5.85 11.5z" />
      <path fill="#00832d" d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="M73.4 26.5 60.7 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}
