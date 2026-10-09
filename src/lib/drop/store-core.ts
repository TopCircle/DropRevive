import type { DateFilter, KindFilter } from "./meta";
import type {
  DropRecord,
  GoogleSession,
  MicrosoftSession,
  ProviderId,
  Scope,
  SendResult,
  Settings,
  Shelf,
  UploadJob,
} from "./types";

/** State shape and helpers every store module shares. */

type DateFilterState = DateFilter;
type KindFilterState = KindFilter;

export type PreviewState = {
  item: DropRecord;
  loading: boolean;
  url?: string;
  text?: string;
  error?: string;
  mode: "text" | "image" | "pdf" | "other";
};

export type AuthError = { provider: ProviderId; code: string; description: string };

export type DropState = {
  hydrated: boolean;
  settings: Settings;
  google: GoogleSession | null;
  microsoft: MicrosoftSession | null;
  items: DropRecord[];
  jobs: UploadJob[];
  busy: boolean;
  syncing: boolean;
  syncError: string | null;
  lastSyncAt: number | null;
  online: boolean;
  query: string;
  kindFilter: KindFilterState;
  providerFilter: "all" | ProviderId;
  dateFilter: DateFilterState;
  selecting: boolean;
  selected: string[];
  preview: PreviewState | null;
  settingsOpen: boolean;
  /** Error from the last sign-in round trip (the Worker sends it back as ?auth_error=…). */
  authError: AuthError | null;
  shelves: Shelf[];
  addShelf: (provider: ProviderId, name: string) => void;
  removeShelf: (provider: ProviderId, id: string) => void;
  moveItem: (id: string, shelfId: string | null) => void;
  /** Phone multi-select: move what may go there, wait for the sync that carries it, report per item. */
  moveItems: (ids: string[], shelfId: string | null) => Promise<{ moved: string[]; pending: string[]; skipped: string[]; already: string[]; missingOn: ProviderId[] }>;
  hydrate: () => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => void;
  setOnline: (online: boolean) => void;
  setQuery: (query: string) => void;
  setKindFilter: (kind: KindFilterState) => void;
  setProviderFilter: (provider: "all" | ProviderId) => void;
  setDateFilter: (date: DateFilterState) => void;
  setSelecting: (selecting: boolean) => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  openSettings: () => void;
  closeSettings: () => void;
  clearAuthError: () => void;
  disconnect: (provider: ProviderId) => Promise<void>;
  /** `interactive` is only for a click on 立即同步. Renewal itself never opens a prompt. */
  sync: (interactive?: boolean) => Promise<void>;
  send: (texts: string[], files: File[], scope: Scope) => Promise<SendResult>;
  remove: (ids: string[]) => Promise<string | null>;
  download: (item: DropRecord) => Promise<void>;
  openPreview: (item: DropRecord) => Promise<void>;
  closePreview: () => void;
  clearCache: () => Promise<void>;
  dismissSyncError: () => void;
};

export type StoreSet = (partial: Partial<DropState> | ((state: DropState) => Partial<DropState>)) => void;
export type StoreGet = () => DropState;

/** Bumped whenever a send, delete or disconnect makes the result of a running sync stale. */
let epoch = 0;

export function invalidateSync(): void {
  epoch += 1;
}

export function syncEpoch(): number {
  return epoch;
}

export function sortItems(items: DropRecord[]): DropRecord[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
