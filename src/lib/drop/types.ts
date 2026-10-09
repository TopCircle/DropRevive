export type ProviderId = "google" | "microsoft";

/** Sidebar selection; also where the composer sends (provider root, or a folder on it). */
export type Scope = { provider: ProviderId | "all"; shelfId: string | null };

export type ThemeMode = "system" | "light" | "dark";

export type DropKind = "text" | "file";

export type Settings = {
  deviceId: string;
  deviceName: string;
  googleClientId: string;
  microsoftClientId: string;
  theme: ThemeMode;
};

/** Access token from the Worker. The refresh token stays in its HttpOnly cookie. */
export type GoogleSession = {
  accessToken: string;
  expiresAt: number;
  clientId: string;
  /** Sessions from the old in-browser sign-in lack this and are dropped on load. */
  via: "server";
  /** Shown in settings and passed as login_hint on reconnect. */
  email?: string;
};

export type MicrosoftSession = {
  accessToken: string;
  expiresAt: number;
  clientId: string;
  /** Sessions from the old in-browser sign-in lack this and are dropped on load. */
  via: "server";
  username?: string;
};

export type TokenBag = {
  google: GoogleSession | null;
  microsoft: MicrosoftSession | null;
};

export type CloudRef = {
  provider: ProviderId;
  metaId: string;
  blobId?: string;
  metaName: string;
  /** Shelf (subfolder) the meta sat in at the last sync; unset = the DropRevive folder itself. */
  shelf?: string;
};

export type DropRecord = {
  id: string;
  kind: DropKind;
  createdAt: string;
  deviceId: string;
  deviceName: string;
  text?: string;
  fileName?: string;
  mimeType?: string;
  size: number;
  refs: CloudRef[];
  revs: Partial<Record<ProviderId, string>>;
  /**
   * Shelf (subfolder) the item should be in, per drive; unset = the DropRevive folder itself.
   * Sync moves that drive's files when it differs from the drive's ref.shelf.
   */
  folders?: Partial<Record<ProviderId, string>>;
};

export type RemoteMeta = {
  id: string;
  name: string;
  modifiedTime: string;
  shelf?: string;
};

export type UploadJob = {
  id: string;
  label: string;
  provider: ProviderId;
  progress: number;
  phase: "uploading" | "done" | "error";
  error?: string;
};

export type UploadedObject = {
  id: string;
  /** Cloud modification time. Absent when the upload response did not include one. */
  modifiedTime?: string;
};

export type SendResult = {
  sent: number;
  failed: number;
  message: string;
  /** Indexes into the files array that never landed on a drive. */
  failedFileIndexes?: number[];
  /** False when a text draft was not stored. Omitted when the send had no text. */
  textSent?: boolean;
};

export const FOLDER_NAME = "DropRevive";
export const SETTINGS_KEY = "droprevive.settings";
export const TOKENS_KEY = "droprevive.tokens";
export const FOLDERS_KEY = "droprevive.folders";
export const SHELVES_KEY = "droprevive.shelves";
export const OUTBOX_KEY = "droprevive.outbox";

/** A subfolder of DropRevive on one drive. `id` is the folder name, the same on every device. */
export type Shelf = {
  id: string;
  provider: ProviderId;
  name: string;
  /** pending: not created in the cloud yet; removed: items go back to DropRevive, then the folder goes. */
  state?: "pending" | "removed";
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  google: "Google Drive",
  microsoft: "OneDrive",
};

export type OutboxEntry = {
  refs: CloudRef[];
};
