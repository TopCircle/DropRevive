import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ArrowLeft, Filter, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { filterItems } from "@/lib/drop/meta";
import { BubbleCard, type Scope } from "@/components/drop/desktop-shell";
import { CopyText } from "@/components/drop/copy-text";
import { scopeLabel } from "@/components/drop/scope";
import { inScope } from "@/lib/drop/desktop-search";
import { oldestFirst, ownNewestKey, useStickToBottom } from "@/components/drop/use-stick-to-bottom";
import { useI18n } from "@/lib/i18n";
import { useDropStore } from "@/lib/drop/store";
import type { DateFilter, KindFilter } from "@/lib/drop/meta";
import { allVisibleSelected, deleteOutcome, moveTargets, toggleAllVisible } from "@/lib/drop/multi-select";
import { appearanceKey, groupByDrive, uniqueItemIds } from "@/lib/drop/search-groups";
import { PROVIDER_LABEL, type DropRecord, type ProviderId } from "@/lib/drop/types";

export function HistoryPane({
  activeId,
  layout,
  revealTools = false,
  heading = true,
  onBack,
  scope,
  onOpen,
}: {
  activeId: string | null;
  layout: "desktop" | "mobile";
  revealTools?: boolean;
  /** Show the drive / folder title row. The phone home view puts the title in the top bar instead. */
  heading?: boolean;
  /** Phone full-screen search: a fixed top bar with back arrow, search field and filter replaces the title row. */
  onBack?: () => void;
  /** Drawer selection on mobile (provider or folder), same filter as the desktop rail. */
  scope?: Scope;
  onOpen: (item: DropRecord) => void;
}) {
  const items = useDropStore((state) => state.items);
  const shelves = useDropStore((state) => state.shelves);
  const query = useDropStore((state) => state.query);
  const setQuery = useDropStore((state) => state.setQuery);
  const kindFilter = useDropStore((state) => state.kindFilter);
  const setKindFilter = useDropStore((state) => state.setKindFilter);
  const providerFilter = useDropStore((state) => state.providerFilter);
  const setProviderFilter = useDropStore((state) => state.setProviderFilter);
  const dateFilter = useDropStore((state) => state.dateFilter);
  const setDateFilter = useDropStore((state) => state.setDateFilter);
  const selecting = useDropStore((state) => state.selecting);
  const setSelecting = useDropStore((state) => state.setSelecting);
  const selected = useDropStore((state) => state.selected);
  const toggleSelected = useDropStore((state) => state.toggleSelected);
  const setSelected = useDropStore((state) => state.setSelected);
  const remove = useDropStore((state) => state.remove);
  const moveItems = useDropStore((state) => state.moveItems);
  const busy = useDropStore((state) => state.busy);
  const { t } = useI18n();
  const [confirm, setConfirm] = useState<{ ids: string[]; title: string; body: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const deviceId = useDropStore((state) => state.settings.deviceId);
  const googleOn = useDropStore((state) => Boolean(state.google));
  const microsoftOn = useDropStore((state) => Boolean(state.microsoft));
  // Same order and scrolling as the desktop stream: oldest on top, opens at the newest.
  const visible = oldestFirst(
    filterItems(scope ? items.filter((item) => inScope(item, scope)) : items, {
      text: query,
      kind: kindFilter,
      provider: providerFilter,
      date: dateFilter,
    }),
  );
  const { scrollRef, contentRef } = useStickToBottom({
    resetKey: [scope?.provider ?? "", scope?.shelfId ?? "", query, kindFilter, providerFilter, dateFilter].join("/"),
    jumpKey: ownNewestKey(visible, deviceId),
    count: visible.length,
  });
  const filtersOn = kindFilter !== "all" || providerFilter !== "all" || dateFilter !== "all" || query.trim().length > 0;
  const screen = Boolean(onBack);
  // Full-screen search groups results the way the drives hold them: drive > folder > items.
  // Only connected drives, and only the one the 来源 filter picks.
  const drives = (["google", "microsoft"] as const).filter(
    (drive) => (drive === "google" ? googleOn : microsoftOn) && (providerFilter === "all" || providerFilter === drive),
  );
  const sections = screen ? groupByDrive(visible, { shelves, drives, includeLocal: providerFilter === "all" }) : [];
  // The grouped list reads top-down (first drive first), so it opens at the top, not the newest.
  const topRef = useRef<HTMLDivElement>(null);
  const searchKey = [query, kindFilter, providerFilter, dateFilter].join("/");
  useLayoutEffect(() => {
    if (topRef.current) topRef.current.scrollTop = 0;
  }, [searchKey]);
  const showTools = revealTools || screen || (layout === "desktop" && (items.length >= 6 || searchOpen || filtersOn || selecting));

  useEffect(() => {
    if (!revealTools) return;
    setSearchOpen(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [revealTools]);

  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
      window.setTimeout(() => searchRef.current?.focus(), 0);
    };
    window.addEventListener("droprevive-search", open);
    return () => window.removeEventListener("droprevive-search", open);
  }, []);

  const chosen = items.filter((item) => selected.includes(item.id));
  // An item on both drives shows twice in search but is one selection; 全选 counts it once.
  const visibleIds = screen ? uniqueItemIds(sections) : visible.map((item) => item.id);
  const allChosen = allVisibleSelected(selected, visibleIds);
  const targets = selecting ? moveTargets(chosen, shelves) : [];
  const folderLabel = (target: string | null) => target ?? t("nav.rootFolder");

  function exitSelect() {
    setSelecting(false);
  }

  /** Long-press a bubble: multi-select starts with that one selected. */
  function startSelect(item: DropRecord) {
    navigator.vibrate?.(15);
    setSelecting(true);
    setSelected([item.id]);
  }

  async function runRemove(ids: string[]) {
    let reason = "";
    try {
      await remove(ids);
    } catch (error) {
      reason = error instanceof Error ? error.message : t("delete.failed");
    }
    const outcome = deleteOutcome(ids, useDropStore.getState().items);
    if (!outcome.done.length) {
      // Nothing went (offline, signed out): keep the selection so it can be tried again.
      toast.error(reason || t("delete.failed"));
      return;
    }
    exitSelect();
    if (outcome.failed.length) toast.warning(t("select.deletedSome", { done: outcome.done.length, failed: outcome.failed.length, reason }));
    else toast.success(t("select.deleted", { count: outcome.done.length }));
  }

  async function moveTo(target: string | null) {
    setMoving(true);
    try {
      const result = await moveItems(chosen.map((item) => item.id), target);
      const name = folderLabel(target);
      const lines: string[] = [];
      if (result.moved.length) lines.push(t("select.moved", { count: result.moved.length, name }));
      if (result.already.length) lines.push(t("select.already", { count: result.already.length, name }));
      if (result.skipped.length) {
        const drives = result.missingOn.map((drive) => PROVIDER_LABEL[drive]).join(" / ");
        lines.push(drives ? t("select.skipped", { count: result.skipped.length, drives, name }) : t("select.skippedLocal", { count: result.skipped.length }));
      }
      if (result.pending.length) lines.push(t("select.pending", { count: result.pending.length }));
      exitSelect();
      const [first = "", ...rest] = lines;
      const options = rest.length ? { description: <div className="whitespace-pre-line">{rest.join("\n")}</div> } : undefined;
      if (result.skipped.length || result.pending.length) toast.warning(first, options);
      else toast.success(first, options);
    } finally {
      setMoving(false);
    }
  }

  // Same bubble as the desktop stream. Tap opens the detail sheet; long-press starts multi-select,
  // where a tap toggles instead. Selection is by item id, so both appearances of a dual-drive item follow.
  function row(item: DropRecord, key: string) {
    const title = item.kind === "text" ? item.text?.split("\n")[0] || t("history.text") : item.fileName || t("history.file");
    const picked = selected.includes(item.id);
    return (
      <li key={key} className="flex w-full min-w-0 items-start gap-2" data-active={item.id === activeId || undefined}>
        {selecting && (
          <input
            type="checkbox"
            className="mt-3 size-4 shrink-0 accent-foreground"
            checked={picked}
            onChange={() => toggleSelected(item.id)}
            aria-label={t("history.selectItem", { title })}
          />
        )}
        <div className="flex min-w-0 flex-col items-start">
          <BubbleCard
            item={item}
            clamp
            pressable
            selected={selecting && picked}
            onTap={() => (selecting ? toggleSelected(item.id) : onOpen(item))}
            onLongPress={() => (selecting ? picked || toggleSelected(item.id) : startSelect(item))}
          />
          {!selecting && item.kind === "text" && item.text && <CopyText text={item.text} className="mt-0.5" />}
        </div>
      </li>
    );
  }

  const menuFiltersOn = kindFilter !== "all" || providerFilter !== "all" || dateFilter !== "all";
  const filterControl = (
    <div className="relative shrink-0">
      <button
        type="button"
        className={`inline-flex h-10 items-center gap-1 rounded-xl px-2 text-sm ${
          menuFiltersOn ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
        aria-expanded={filterOpen}
        onClick={() => setFilterOpen((open) => !open)}
      >
        <Filter className="size-4" />
        {t("history.filter")}
      </button>
      {filterOpen && (
        <FilterMenu
          kind={kindFilter}
          provider={providerFilter}
          date={dateFilter}
          onKind={setKindFilter}
          onProvider={setProviderFilter}
          onDate={setDateFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {screen && (
        // Fixed top bar; the results below scroll under it.
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
          <Button variant="ghost" size="icon" className="shrink-0" aria-label={t("history.back")} onClick={onBack}>
            <ArrowLeft className="size-5" />
          </Button>
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card px-3">
            <Search className="size-4 shrink-0 text-subtle" />
            <span className="sr-only">{t("history.searchLabel")}</span>
            <input
              ref={searchRef}
              autoFocus
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("history.search")}
              className="min-w-0 flex-1 bg-transparent text-base outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
                aria-label={t("history.clearQuery")}
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X className="size-4" />
              </button>
            )}
          </label>
          {filterControl}
        </div>
      )}
      {!screen && (heading || showTools) && (
        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
          {heading ? (
            <h2 className="min-w-0 flex-1 truncate text-center text-lg font-semibold tracking-tight text-foreground">
              {scope ? scopeLabel(scope, shelves) : t("history.records")}
            </h2>
          ) : (
            <span className="flex-1" aria-hidden="true" />
          )}
          {showTools && !searchOpen && (
            <button
              type="button"
              className="inline-flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted"
              aria-label={t("history.search")}
              onClick={() => {
                setSearchOpen(true);
                window.setTimeout(() => searchRef.current?.focus(), 0);
              }}
            >
              <Search className="size-4" />
            </button>
          )}
          {showTools && filterControl}
        </div>
      )}

      {!screen && searchOpen && (
        <div className="px-4 pb-2">
          <label className="flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-3">
            <Search className="size-4 text-subtle" />
            <span className="sr-only">{t("history.searchLabel")}</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("history.search")}
              className="w-full bg-transparent text-sm outline-none"
            />
            <button
              type="button"
              aria-label={t("history.closeSearch")}
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            >
              <X className="size-4 text-muted-foreground" />
            </button>
          </label>
        </div>
      )}

      {selecting && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <Button variant="ghost" size="icon" className="shrink-0" aria-label={t("select.exit")} onClick={exitSelect}>
            <X className="size-5" />
          </Button>
          <p className="min-w-0 flex-1 truncate text-base font-medium" aria-live="polite">
            {t("history.selected", { count: chosen.length })}
          </p>
        </div>
      )}

      <div
        ref={screen ? topRef : scrollRef}
        data-timeline=""
        className={`scrollbar-pill min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4`}
      >
        <div ref={screen ? undefined : contentRef}>
          {(screen ? sections.length === 0 : visible.length === 0) ? (
            <p className="px-2 py-3 text-sm leading-6 text-muted-foreground">
              {items.length > 0 ? t("empty.filtered") : t("empty.history")}
            </p>
          ) : screen ? (
            sections.map((section) => (
              <section key={section.key} data-drive-section={section.drive} aria-label={section.drive === "local" ? t("search.local") : PROVIDER_LABEL[section.drive]}>
                {/* Sticky: the drive row pins at the top, its folder row right under it (h-9 = top-9). */}
                <h3 className="sticky top-0 z-20 -mx-3 flex h-9 items-center gap-2 bg-background px-3 text-sm font-semibold">
                  <span className="min-w-0 truncate">{section.drive === "local" ? t("search.local") : PROVIDER_LABEL[section.drive]}</span>
                  <span className="text-xs font-normal text-subtle">{section.count}</span>
                </h3>
                {section.folders.map((group) => (
                  <div key={group.key} data-folder-group={group.key}>
                    {section.drive !== "local" && (
                      <h4 className="sticky top-9 z-10 -mx-3 flex h-8 items-center gap-2 border-b border-border/60 bg-background px-3 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate">{group.name ?? t("nav.rootFolder")}</span>
                        <span className="text-subtle">{group.items.length}</span>
                      </h4>
                    )}
                    <ul className="flex flex-col items-start gap-2 pt-2 pb-3">{group.items.map((item) => row(item, appearanceKey(group, item)))}</ul>
                  </div>
                ))}
              </section>
            ))
          ) : (
            <ul className="flex flex-col items-start gap-2 pt-1">{visible.map((item) => row(item, item.id))}</ul>
          )}
        </div>
      </div>

      {selecting && (
        // The search screen already pads for the home indicator; the home list doesn't (the composer did).
        <div className={`flex shrink-0 items-center gap-2 border-t border-border bg-background px-3 pt-2 ${screen ? "pb-2" : "pb-[max(0.5rem,env(safe-area-inset-bottom))]"}`}>
          <Button variant="ghost" size="sm" className="shrink-0" disabled={!visibleIds.length} onClick={() => setSelected(toggleAllVisible(selected, visibleIds))}>
            {allChosen ? t("select.none") : t("select.all")}
          </Button>
          <select
            aria-label={t("nav.moveToFolder")}
            value=""
            disabled={!chosen.length || !targets.length || moving || busy}
            onChange={(event) => void moveTo(event.target.value === ROOT ? null : event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-full bg-muted px-3 text-sm text-foreground outline-none disabled:opacity-50"
          >
            <option value="" disabled>
              {moving ? t("select.moving") : t("nav.moveToFolderPrompt")}
            </option>
            {targets.map((option) => (
              <option key={option.target ?? ROOT} value={option.target ?? ROOT}>
                {option.fits < option.total
                  ? t("select.someFit", { name: folderLabel(option.target), count: option.fits, total: option.total })
                  : folderLabel(option.target)}
              </option>
            ))}
          </select>
          <Button
            variant="danger"
            size="sm"
            className="shrink-0"
            disabled={!chosen.length || busy || moving}
            onClick={() => setConfirm({ ids: chosen.map((item) => item.id), title: t("delete.manyTitle", { count: chosen.length }), body: t("delete.body") })}
          >
            {t("delete.confirm")}
          </Button>
        </div>
      )}

      <AlertDialog.Root open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-card p-5">
            <AlertDialog.Title className="text-lg font-medium">{confirm?.title}</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">{confirm?.body}</AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="outline">{t("delete.cancel")}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="danger" onClick={() => { if (confirm) void runRemove(confirm.ids); }}>
                  {t("delete.confirm")}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

const ROOT = "\u0000root";

function FilterMenu({
  kind,
  provider,
  date,
  onKind,
  onProvider,
  onDate,
  onClose,
}: {
  kind: KindFilter;
  provider: "all" | ProviderId;
  date: DateFilter;
  onKind: (kind: KindFilter) => void;
  onProvider: (provider: "all" | ProviderId) => void;
  onDate: (date: DateFilter) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label={t("history.closeFilter")} onClick={onClose} />
      <div className="absolute top-11 right-0 z-30 w-56 rounded-2xl border border-border bg-card p-2 shadow-sm">
        <FilterRow label={t("history.kind")} value={kind} options={[["all", t("history.all")], ["text", t("history.text")], ["file", t("history.file")]]} onChange={(value) => onKind(value as KindFilter)} />
        <FilterRow label={t("history.source")} value={provider} options={[["all", t("history.all")], ["google", "Google Drive"], ["microsoft", "OneDrive"]]} onChange={(value) => onProvider(value as "all" | ProviderId)} />
        <FilterRow label={t("history.when")} value={date} options={[["all", t("history.all")], ["1", t("history.today")], ["7", t("history.days7")], ["30", t("history.days30")]]} onChange={(value) => onDate(value as DateFilter)} />
      </div>
    </>
  );
}

function FilterRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1 text-sm">
      <span className="w-16 shrink-0 text-subtle">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded-lg bg-muted px-2 text-sm outline-none"
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
