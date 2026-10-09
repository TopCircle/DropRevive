import { toast } from "sonner";
import { create } from "zustand";
import { t } from "@/lib/i18n";
import { asCloudError } from "./errors";
import { GOOGLE_CLIENT_ID, MS_CLIENT_ID } from "./client-env";
import { driveLogout, onRenewal } from "./drive-token";
import { forgetGoogleFolder } from "./google";
import { clearItemCache, loadItems } from "./idb";
import { forgetMicrosoftFolder } from "./microsoft";
import { forgetDrive, foldersFor, setFolder } from "./reconcile";
import { loadSecret, readJson, writeJson } from "./secrets";
import { moveOutcome, planMove } from "./multi-select";
import {
  fetchBlob,
  mimeOf,
  persisted,
  queuePersist,
  queueSecret,
  revokePreview,
  setLocalReadable,
  setPreviewUrl,
} from "./store-cache";
import { type DropState, invalidateSync, sortItems } from "./store-core";
import { removeItems } from "./store-delete";
import {
  adoptServerSessions,
  applyRenewal,
  dropLegacyAuth,
  holdSyncsUntil,
  ownSession,
  providersToRefresh,
  readAuthReturn,
  SESSION_CHECK_CAP_MS,
} from "./store-session";
import { applyTheme, INITIAL_SETTINGS, normalizeSettings } from "./store-settings";
import { loadShelves, migrateFolders, saveShelves, shelfName } from "./store-shelves";
import { runSync } from "./store-sync";
import { sendDrafts } from "./store-upload";
import {
  PROVIDER_LABEL,
  SETTINGS_KEY,
  TOKENS_KEY,
  type DropRecord,
  type GoogleSession,
  type MicrosoftSession,
  type Settings,
  type TokenBag,
} from "./types";

// The drop store. State, actions and the zustand API live here; the work behind them is in
// store-session (sign-in and tokens), store-sync, store-upload, store-delete, store-cache
// (local persistence, blobs, preview), store-shelves and store-settings.

export type { PreviewState } from "./store-core";
export { applyTheme } from "./store-settings";
export { mimeOf } from "./store-cache";
export { sendTargets } from "./store-upload";

// Counts failed-disconnect toasts, so each retry gets its own toast id.
let disconnectToasts = 0;

export const useDropStore = create<DropState>((set, get) => ({
  hydrated: false,
  settings: INITIAL_SETTINGS,
  google: null,
  microsoft: null,
  items: [],
  jobs: [],
  busy: false,
  syncing: false,
  syncError: null,
  lastSyncAt: null,
  online: true,
  query: "",
  kindFilter: "all",
  providerFilter: "all",
  dateFilter: "all",
  selecting: false,
  selected: [],
  preview: null,
  settingsOpen: false,
  authError: null,
  shelves: [],

  hydrate: async () => {
    if (get().hydrated || typeof window === "undefined") return;
    const settings = normalizeSettings(readJson<unknown>(SETTINGS_KEY, null));
    writeJson(SETTINGS_KEY, settings);
    applyTheme(settings.theme);
    const tokens = (await loadSecret<TokenBag>(TOKENS_KEY)) ?? { google: null, microsoft: null };
    const { shelves, renamed } = loadShelves();
    const loaded = await loadItems();
    const localReadable = loaded !== null;
    setLocalReadable(localReadable);
    const items = sortItems(loaded ?? []).map((item) => migrateFolders(item, renamed));
    const upgraded = dropLegacyAuth(tokens);
    const google = ownSession(tokens.google, GOOGLE_CLIENT_ID);
    const microsoft = ownSession(tokens.microsoft, MS_CLIENT_ID);
    const returned = readAuthReturn();
    const ask = providersToRefresh(google, microsoft, returned.connected, upgraded);
    // Set before `hydrated` flips, so even the very first sync waits for the /token check below:
    // right after load (back from a sign-in, or an access token that lapsed while the app was
    // closed) the stored session is stale or missing, and a sync ahead of the Worker's answer
    // fails with a warning that means nothing.
    let checked = () => {};
    if (ask) holdSyncsUntil(new Promise<void>((resolve) => (checked = resolve)));
    set({
      settings,
      google,
      microsoft,
      items,
      hydrated: true,
      online: navigator.onLine,
      shelves,
      ...(returned.error ? { authError: returned.error, settingsOpen: true } : {}),
      ...(!localReadable ? { syncError: t("err.historyOpen") } : {}),
    });
    if (upgraded) {
      toast(t("auth.upgraded"), {
        duration: 20_000,
        action: { label: t("auth.openSettings"), onClick: () => get().openSettings() },
      });
    }
    if (upgraded || google !== tokens.google || microsoft !== tokens.microsoft) {
      queueSecret({ google, microsoft });
    }
    if (ask) {
      const cap = setTimeout(checked, SESSION_CHECK_CAP_MS);
      void adoptServerSessions(get, set, returned.connected, ask)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(cap);
          checked();
        });
    }
  },

  patchSettings: (patch) => {
    const current = get().settings;
    const settings: Settings = {
      ...current,
      ...patch,
      deviceName:
        patch.deviceName !== undefined
          ? patch.deviceName.trim().slice(0, 40) || t("device.this")
          : current.deviceName,
    };
    set({ settings });
    writeJson(SETTINGS_KEY, settings);
    if (patch.theme) applyTheme(settings.theme);
  },

  setOnline: (online) => set({ online }),
  // A new query or filter shows a different list, so a selection made on the old one is dropped.
  setQuery: (query) => set(query === get().query ? { query } : { query, selected: [] }),
  setKindFilter: (kindFilter) => set(kindFilter === get().kindFilter ? { kindFilter } : { kindFilter, selected: [] }),
  setProviderFilter: (providerFilter) => set(providerFilter === get().providerFilter ? { providerFilter } : { providerFilter, selected: [] }),
  setDateFilter: (dateFilter) => set(dateFilter === get().dateFilter ? { dateFilter } : { dateFilter, selected: [] }),
  setSelecting: (selecting) => set({ selecting, selected: selecting ? get().selected : [] }),
  toggleSelected: (id) => {
    const selected = get().selected.includes(id)
      ? get().selected.filter((item) => item !== id)
      : [...get().selected, id];
    set({ selected });
  },
  setSelected: (selected) => set({ selected }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  addShelf: (provider, name) => {
    const clean = shelfName(name);
    if (!clean) return;
    // A folder lives on the drive it was created under only.
    const kept = get().shelves.filter((shelf) => !(shelf.id === clean && shelf.provider === provider));
    saveShelves(set, [...kept, { id: clean, name: clean, provider, state: "pending" as const }]);
    void get().sync();
  },
  removeShelf: (provider, id) => {
    // Only this drive's folder; a same-named folder on the other drive stays.
    saveShelves(set, get().shelves.map((shelf) => (shelf.id === id && shelf.provider === provider ? { ...shelf, state: "removed" as const } : shelf)));
    set({
      items: get().items.map((item) => (item.folders?.[provider] === id ? { ...item, folders: setFolder(item.folders, provider, undefined) } : item)),
    });
    void get().sync();
  },
  moveItem: (id, shelfId) => {
    // The picker only offers folders every drive holding the item has, so move each copy.
    set({ items: get().items.map((item) => (item.id === id ? { ...item, folders: foldersFor(item.refs, shelfId || undefined) } : item)) });
    void get().sync();
  },
  moveItems: async (ids, shelfId) => {
    const plan = planMove(get().items.filter((item) => ids.includes(item.id)), get().shelves, shelfId);
    if (plan.movable.length) {
      const movable = new Set(plan.movable);
      set({ items: get().items.map((item) => (movable.has(item.id) ? { ...item, folders: foldersFor(item.refs, shelfId ?? undefined) } : item)) });
      // The sync moves the cloud files; one already running queues another pass and this waits for it.
      await get().sync();
    }
    const outcome = moveOutcome(plan.movable, get().items, shelfId);
    return { moved: outcome.done, pending: outcome.failed, skipped: plan.skipped, already: plan.already, missingOn: plan.missingOn };
  },
  dismissSyncError: () => set({ syncError: null }),
  clearAuthError: () => set({ authError: null }),

  disconnect: async (provider) => {
    const previous = get()[provider];
    set(provider === "google" ? { google: null } : { microsoft: null });
    await persisted();
    try {
      // Waits for any renewal still running, so the Worker's cookie-clearing answer comes last.
      await driveLogout(provider);
    } catch {
      // Not confirmed: this device may still hold the sign-in cookie. Show the drive as
      // connected again (its access token still works) and offer the same step once more.
      if (previous && !get()[provider]) {
        set(provider === "google" ? { google: previous as GoogleSession } : { microsoft: previous as MicrosoftSession });
      }
      // A fresh id per attempt: sonner drops a toast that reuses the id of one still closing
      // (clicking 「重试」 closes the old toast), so a second failure would show nothing.
      const id = `disconnect-${provider}-${++disconnectToasts}`;
      toast.dismiss(`disconnect-${provider}-${disconnectToasts - 1}`);
      toast.error(t("auth.disconnectFailed", { provider: PROVIDER_LABEL[provider] }), {
        id,
        duration: 20_000,
        action: { label: t("auth.retry"), onClick: () => void useDropStore.getState().disconnect(provider) },
      });
      return;
    }
    if (provider === "google") forgetGoogleFolder();
    else forgetMicrosoftFolder();
    // Confirmed: forget this drive's folders here (the cloud keeps them; reconnecting
    // lists them again). A sync already running started from the old list, so drop its
    // result and run again for the other drive.
    invalidateSync();
    const forgotten = forgetDrive(provider, get().items, get().shelves);
    saveShelves(set, forgotten.shelves);
    if (forgotten.items !== get().items) set({ items: forgotten.items });
    void get().sync();
  },

  sync: (interactive = false) => runSync(set, get, interactive),

  send: (texts, files, scope) => sendDrafts(texts, files, scope, set, get),

  remove: (ids) => removeItems(ids, set, get),

  download: async (item) => {
    const blob = await fetchBlob(item, get);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.fileName || `droprevive-${item.id}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  },

  openPreview: async (item) => {
    revokePreview();
    if (item.kind === "text") {
      set({
        preview: { item, loading: false, text: item.text || "", mode: "text" },
      });
      return;
    }
    const mime = mimeOf(item);
    const mode = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "other";
    set({ preview: { item, loading: mode !== "other", mode } });
    if (mode === "other") return;
    try {
      const blob = await fetchBlob(item, get);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      if (get().preview?.item.id !== item.id) {
        URL.revokeObjectURL(url);
        setPreviewUrl(null);
        return;
      }
      set({ preview: { item, loading: false, url, mode } });
    } catch (error) {
      if (get().preview?.item.id !== item.id) return;
      set({
        preview: {
          item,
          loading: false,
          mode,
          error: asCloudError(error, t("err.preview")).message,
        },
      });
    }
  },

  closePreview: () => {
    revokePreview();
    set({ preview: null });
  },

  clearCache: async () => {
    await clearItemCache();
    set({ items: [], selected: [], selecting: false });
  },
}));

useDropStore.subscribe((state, prev) => {
  if (!prev.hydrated || !state.hydrated) return;
  if (state.items !== prev.items) queuePersist(state.items, useDropStore.setState);
  // Any connect, renewal or disconnect lands in the encrypted token store, so sessions survive a reload.
  if (state.google !== prev.google || state.microsoft !== prev.microsoft) {
    const bag: TokenBag = { google: state.google, microsoft: state.microsoft };
    queueSecret(bag);
  }
});

onRenewal((provider, renewed) => applyRenewal(useDropStore, provider, renewed));

/** The item's file, from the IndexedDB cache or the drive (then cached). */
export function itemBlob(item: DropRecord): Promise<Blob> {
  return fetchBlob(item, useDropStore.getState);
}
