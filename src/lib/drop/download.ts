import { t } from "@/lib/i18n";
import { asCloudError, CloudError } from "./errors";
import { googleMediaUrl, openGoogleMedia } from "./google";
import { CACHE_BLOB_MAX_BYTES } from "./idb";
import { microsoftDownloadUrl } from "./microsoft";
import { fetchBlob } from "./store-cache";
import type { StoreGet } from "./store-core";
import type { DropRecord, ProviderId } from "./types";

export { CACHE_BLOB_MAX_BYTES };

/**
 * Whole-file Blob path, IndexedDB cache and in-page preview all stop above this size
 * (~32 MiB). Larger files are streamed to disk.
 */
export const BLOB_FILE_MAX_BYTES = CACHE_BLOB_MAX_BYTES;

export const DRIVE_DOWNLOAD_SW_TYPE = "droprevive-drive-download";
export const DRIVE_DOWNLOAD_SW_PATH = "/__drive-download/";

export type DownloadMethod =
  | "onedrive-url"
  | "blob"
  | "save-picker"
  | "sw-stream"
  | "opfs-share"
  | "unsupported";

export type TokenFor = (provider: ProviderId) => string | undefined;

export type SavePickerHandle = {
  createWritable: () => Promise<WritableStream>;
};

export type OpfsFileHandle = {
  createWritable?: () => Promise<WritableStream>;
  getFile: () => Promise<File>;
};

export type OpfsDir = {
  getFileHandle: (name: string, opts: { create: boolean }) => Promise<OpfsFileHandle>;
};

export type ServiceWorkerLike = {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

export type DownloadHost = {
  userAgent: string;
  origin?: string;
  showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<SavePickerHandle>;
  serviceWorker?: () => Promise<ServiceWorkerLike | null>;
  /** Test hook; the browser host talks to the Service Worker over a MessageChannel. */
  postToWorker?: (message: unknown, transfer: Transferable[]) => Promise<boolean>;
  clickLink: (url: string, fileName: string, opts?: { newTab?: boolean }) => void;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  getDirectory?: () => Promise<OpfsDir>;
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[] }) => Promise<void>;
  randomId?: () => string;
};

export type DriveDownloadIo = {
  microsoftDownloadUrl: (token: string, itemId: string) => Promise<string>;
  openGoogleMedia: (token: string, fileId: string) => Promise<Response>;
  fetchBlob: (item: DropRecord) => Promise<Blob>;
};

/** Safari and every iOS browser (all WebKit): Service Worker streaming downloads are unreliable. */
export function isSafariLike(ua: string): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android|OPR|Firefox|FxiOS/i.test(ua);
}

export function shouldCacheBlob(size: number): boolean {
  return size <= BLOB_FILE_MAX_BYTES;
}

export function isTooLargeToPreview(item: DropRecord): boolean {
  return item.kind === "file" && item.size > BLOB_FILE_MAX_BYTES;
}

export function isUserCancel(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function isDriveDownloadId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function isAllowedGoogleMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.googleapis.com" &&
      parsed.pathname.startsWith("/drive/v3/files/") &&
      parsed.searchParams.get("alt") === "media"
    );
  } catch {
    return false;
  }
}

export function contentDispositionAttachment(fileName: string): string {
  const raw = (fileName || "download").replace(/[\r\n"]/g, "_");
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

export function pickDownloadMethod(input: {
  provider: "google" | "microsoft";
  size: number;
  hasSavePicker: boolean;
  hasServiceWorker: boolean;
  isSafari: boolean;
  hasOpfs: boolean;
}): DownloadMethod {
  if (input.provider === "microsoft") return "onedrive-url";
  if (input.size <= BLOB_FILE_MAX_BYTES) return "blob";
  if (input.hasSavePicker) return "save-picker";
  if (input.hasServiceWorker && !input.isSafari) return "sw-stream";
  if (input.hasOpfs) return "opfs-share";
  return "unsupported";
}

export function defaultHost(): DownloadHost {
  const clickLink = (url: string, fileName: string, opts?: { newTab?: boolean }) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    if (opts?.newTab) anchor.target = "_blank";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };
  const w = globalThis as typeof globalThis & {
    showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<SavePickerHandle>;
  };
  const picker =
    typeof w.showSaveFilePicker === "function" ? w.showSaveFilePicker.bind(w) : undefined;
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  const getDirectory =
    storage && typeof storage.getDirectory === "function"
      ? () => storage.getDirectory() as Promise<OpfsDir>
      : undefined;
  return {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    origin: typeof location !== "undefined" ? location.origin : "",
    showSaveFilePicker: picker,
    serviceWorker: async () => {
      if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
      const asLike = (sw: ServiceWorker | null): ServiceWorkerLike | null =>
        sw ? { postMessage: (message, transfer) => sw.postMessage(message, transfer) } : null;
      if (navigator.serviceWorker.controller) return asLike(navigator.serviceWorker.controller);
      const ready = navigator.serviceWorker.ready.then((reg) => asLike(reg.active));
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 3000);
      });
      return (await Promise.race([ready, timeout])) ?? null;
    },
    clickLink,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    getDirectory,
    canShare:
      typeof navigator !== "undefined" && typeof navigator.canShare === "function"
        ? (data) => navigator.canShare(data)
        : undefined,
    share:
      typeof navigator !== "undefined" && typeof navigator.share === "function"
        ? (data) => navigator.share(data)
        : undefined,
    randomId: () => crypto.randomUUID(),
  };
}

export function defaultIo(get?: StoreGet): DriveDownloadIo {
  return {
    microsoftDownloadUrl,
    openGoogleMedia,
    fetchBlob: (item) => {
      if (!get) throw new CloudError(t("err.download"));
      return fetchBlob(item, get);
    },
  };
}

async function postToWorker(
  host: DownloadHost,
  worker: ServiceWorkerLike,
  message: unknown,
  transfer: Transferable[],
): Promise<boolean> {
  if (host.postToWorker) return host.postToWorker(message, transfer);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 8000);
    channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean }>) => {
      clearTimeout(timer);
      resolve(event.data?.ok === true);
    };
    try {
      worker.postMessage(message, [channel.port2, ...transfer]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function objectUrlFns(host: DownloadHost): {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
} {
  return {
    create: host.createObjectURL ?? ((blob) => URL.createObjectURL(blob)),
    revoke: host.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url)),
  };
}

async function saveGoogleBlob(item: DropRecord, host: DownloadHost, io: DriveDownloadIo): Promise<void> {
  const blob = await io.fetchBlob(item);
  const urls = objectUrlFns(host);
  const url = urls.create(blob);
  host.clickLink(url, item.fileName || "download");
  setTimeout(() => urls.revoke(url), 2000);
}

async function streamToPicker(response: Response, host: DownloadHost, fileName: string): Promise<void> {
  if (!host.showSaveFilePicker) throw new CloudError(t("err.googleLargeNoStream"));
  if (!response.body) throw new CloudError(t("err.googleDownload"));
  const handle = await host.showSaveFilePicker({ suggestedName: fileName });
  const writable = await handle.createWritable();
  await response.body.pipeTo(writable);
}

function tokenInUrl(url: string, token: string): boolean {
  return Boolean(token) && url.includes(token);
}

async function streamToServiceWorker(
  response: Response,
  host: DownloadHost,
  fileName: string,
  mime: string | undefined,
  size: number,
  token: string,
  fileId: string,
): Promise<void> {
  const worker = (await host.serviceWorker?.()) ?? null;
  if (!worker && !host.postToWorker) throw new CloudError(t("err.googleLargeNoStream"));
  const id = host.randomId?.() ?? crypto.randomUUID();
  if (!isDriveDownloadId(id)) throw new CloudError(t("err.download"));
  const base = {
    type: DRIVE_DOWNLOAD_SW_TYPE,
    id,
    fileName,
    mime: mime || "application/octet-stream",
    size,
  };
  const stub: ServiceWorkerLike = worker ?? { postMessage() {} };
  let ok = false;
  if (response.body) {
    ok = await postToWorker(host, stub, { ...base, stream: response.body }, [response.body]);
  }
  if (!ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Body may already have been transferred.
    }
    ok = await postToWorker(
      host,
      stub,
      { ...base, fileUrl: googleMediaUrl(fileId), accessToken: token },
      [],
    );
  }
  if (!ok) throw new CloudError(t("err.googleLargeNoStream"));
  const origin = host.origin ?? (typeof location !== "undefined" ? location.origin : "");
  const url = `${origin}${DRIVE_DOWNLOAD_SW_PATH}${id}`;
  if (tokenInUrl(url, token) || /[?&](access_token|token|bearer)=/i.test(url)) {
    throw new CloudError(t("err.download"));
  }
  host.clickLink(url, fileName);
}

function opfsName(fileName: string): string {
  return fileName.replace(/[/\\]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "download";
}

async function streamToOpfsAndShare(
  response: Response,
  host: DownloadHost,
  fileName: string,
  mime: string | undefined,
): Promise<void> {
  if (!host.getDirectory) throw new CloudError(t("err.googleLargeNoStream"));
  if (!response.body) throw new CloudError(t("err.googleDownload"));
  const dir = await host.getDirectory();
  const handle = await dir.getFileHandle(opfsName(fileName), { create: true });
  if (typeof handle.createWritable !== "function") {
    throw new CloudError(t("err.googleLargeNoStream"));
  }
  const writable = await handle.createWritable();
  await response.body.pipeTo(writable);
  const file = await handle.getFile();
  const named =
    file.name === fileName ? file : new File([file], fileName, { type: mime || file.type || "application/octet-stream" });
  if (host.canShare?.({ files: [named] }) && host.share) {
    try {
      await host.share({ files: [named] });
    } catch (error) {
      if (isUserCancel(error)) return;
      throw error;
    }
    return;
  }
  // A huge object URL would sit in memory; refuse rather than risk an out-of-memory crash.
  throw new CloudError(t("err.googleLargeNoStream"));
}

async function saveGoogleFile(
  item: DropRecord,
  fileId: string,
  token: string,
  tokenFor: TokenFor,
  host: DownloadHost,
  io: DriveDownloadIo,
): Promise<void> {
  const fileName = item.fileName || "download";
  const method = pickDownloadMethod({
    provider: "google",
    size: item.size,
    hasSavePicker: typeof host.showSaveFilePicker === "function",
    hasServiceWorker: typeof host.serviceWorker === "function" || typeof host.postToWorker === "function",
    isSafari: isSafariLike(host.userAgent),
    hasOpfs: typeof host.getDirectory === "function",
  });
  if (method === "blob") {
    await saveGoogleBlob(item, host, io);
    return;
  }

  const open = () => io.openGoogleMedia(token, fileId);

  const attempts: Array<() => Promise<void>> = [];
  if (method === "save-picker" || host.showSaveFilePicker) {
    attempts.push(async () => streamToPicker(await open(), host, fileName));
  }
  const canUseSw =
    !isSafariLike(host.userAgent) &&
    (typeof host.serviceWorker === "function" || typeof host.postToWorker === "function");
  if (canUseSw && (method === "sw-stream" || method === "save-picker")) {
    attempts.push(async () =>
      streamToServiceWorker(await open(), host, fileName, item.mimeType, item.size, token, fileId),
    );
  }
  if (method === "opfs-share" || host.getDirectory) {
    attempts.push(async () => streamToOpfsAndShare(await open(), host, fileName, item.mimeType));
  }

  let last: unknown;
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (isUserCancel(error)) return;
      last = error;
    }
  }
  throw asCloudError(last, t("err.googleLargeNoStream"));
}

/**
 * Save a cloud file to the user's disk without loading a large file into a single Blob.
 * OneDrive always hands the pre-authenticated download URL to the browser.
 * Google streams (Save As, Service Worker, or OPFS+share) above {@link BLOB_FILE_MAX_BYTES}.
 */
export async function saveCloudFile(
  item: DropRecord,
  tokenFor: TokenFor,
  host: DownloadHost = defaultHost(),
  io: DriveDownloadIo = defaultIo(),
): Promise<void> {
  if (item.kind !== "file") throw new CloudError(t("err.noBlob"));
  let last: unknown;
  let tried = false;
  for (const ref of item.refs) {
    const token = tokenFor(ref.provider);
    if (!token || !ref.blobId) continue;
    tried = true;
    try {
      if (ref.provider === "microsoft") {
        const url = await io.microsoftDownloadUrl(token, ref.blobId);
        if (!url.startsWith("https:")) throw new CloudError(t("err.msNoUrl"));
        host.clickLink(url, item.fileName || "download", { newTab: true });
        return;
      }
      if (ref.provider === "google") {
        await saveGoogleFile(item, ref.blobId, token, tokenFor, host, io);
        return;
      }
    } catch (error) {
      if (isUserCancel(error)) return;
      last = error;
    }
  }
  if (last) throw asCloudError(last, t("err.download"));
  if (!tried) throw new CloudError(t("err.download"));
  throw new CloudError(t("err.download"));
}
