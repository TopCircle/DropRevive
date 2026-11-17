import { t } from "@/lib/i18n";
import { asCloudError, CloudError } from "./errors";
import { formatBytes } from "./format";
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

export type DownloadPhase = "progress" | "handed-off" | "error";

/** What both download buttons render. `handed-off` is not a completed percent. */
export type DownloadView = {
  itemId: string;
  phase: DownloadPhase;
  loaded: number;
  total: number | null;
  error: string | null;
};

export type DownloadObserve = {
  onProgress?: (loaded: number, total?: number) => void;
  onHandoff?: () => void;
  /** Token renewal and any other network wait. Call it after Save As, before opening the file. */
  prepareNetwork?: () => Promise<void>;
};

/** Text for the shared status line. Unknown totals stay a byte count, never a percent. */
export function describeDownload(view: DownloadView): string {
  if (view.phase === "handed-off") return t("download.handedOff");
  if (view.phase === "error") return view.error || t("bubble.downloadFailed");
  if (view.total && view.total > 0) {
    return t("download.progress", { loaded: formatBytes(view.loaded), total: formatBytes(view.total) });
  }
  if (view.loaded > 0) return t("download.progressUnknown", { loaded: formatBytes(view.loaded) });
  return t("download.working");
}

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
  clickLink: (url: string, fileName: string, opts?: { newTab?: boolean; downloadAttribute?: boolean }) => void;
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
  fetchBlob: (item: DropRecord, onProgress?: (loaded: number, total?: number) => void) => Promise<Blob>;
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
  const clickLink = (url: string, fileName: string, opts?: { newTab?: boolean; downloadAttribute?: boolean }) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    // Chrome does not send <a download> through the page's service worker, so a
    // same-origin stream URL must not set the attribute. Content-Disposition names the file.
    if (opts?.downloadAttribute !== false) anchor.download = fileName;
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
      if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return null;
      const sw = navigator.serviceWorker.controller;
      return { postMessage: (message, transfer) => sw.postMessage(message, transfer) };
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
    fetchBlob: (item, onProgress) => {
      if (!get) throw new CloudError(t("err.download"));
      return fetchBlob(item, get, onProgress);
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

async function cancelBody(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Already closed, transferred, or locked by the reader that just cancelled it.
  }
}

function byteTotal(response: Response, fallback: number): number | undefined {
  const header = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(header) && header > 0) return header;
  if (fallback > 0) return fallback;
  return undefined;
}

/** Count bytes as they move. A failed write cancels the source and aborts the destination. */
async function pump(
  body: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  onProgress: ((loaded: number, total?: number) => void) | undefined,
  total: number | undefined,
): Promise<void> {
  const reader = body.getReader();
  const writer = writable.getWriter();
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      onProgress?.(loaded, total);
      await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The source may already be closed.
    }
    try {
      await writer.abort(error);
    } catch {
      // The destination may already be closed.
    }
    throw error;
  }
}

async function saveGoogleBlob(
  item: DropRecord,
  host: DownloadHost,
  io: DriveDownloadIo,
  observe?: DownloadObserve,
): Promise<void> {
  await observe?.prepareNetwork?.();
  const blob = await io.fetchBlob(item, (loaded, total) => observe?.onProgress?.(loaded, total));
  const urls = objectUrlFns(host);
  const url = urls.create(blob);
  host.clickLink(url, item.fileName || "download");
  setTimeout(() => urls.revoke(url), 2000);
}

async function streamToPicker(
  open: () => Promise<Response>,
  host: DownloadHost,
  fileName: string,
  size: number,
  observe?: DownloadObserve,
): Promise<void> {
  if (!host.showSaveFilePicker) throw new CloudError(t("err.googleLargeNoStream"));
  // First await in the click. A renewal request before this drops Chrome's user activation.
  const handle = await host.showSaveFilePicker({ suggestedName: fileName });
  await observe?.prepareNetwork?.();
  const response = await open();
  try {
    if (!response.body) throw new CloudError(t("err.googleDownload"));
    const writable = await handle.createWritable();
    const total = byteTotal(response, size);
    await pump(response.body, writable, observe?.onProgress, total);
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
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
  tokenFor: TokenFor,
  fileId: string,
  observe?: DownloadObserve,
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
    await cancelBody(response);
    const token = tokenFor("google");
    if (!token) throw new CloudError(t("err.download"));
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
  const token = tokenFor("google") || "";
  if (tokenInUrl(url, token) || /[?&](access_token|token|bearer)=/i.test(url)) {
    throw new CloudError(t("err.download"));
  }
  observe?.onHandoff?.();
  host.clickLink(url, fileName, { downloadAttribute: false });
}

function opfsName(fileName: string): string {
  return fileName.replace(/[/\\]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "download";
}

async function streamToOpfsAndShare(
  open: () => Promise<Response>,
  host: DownloadHost,
  fileName: string,
  mime: string | undefined,
  size: number,
  observe?: DownloadObserve,
): Promise<void> {
  if (!host.getDirectory) throw new CloudError(t("err.googleLargeNoStream"));
  const dir = await host.getDirectory();
  const handle = await dir.getFileHandle(opfsName(fileName), { create: true });
  if (typeof handle.createWritable !== "function") {
    throw new CloudError(t("err.googleLargeNoStream"));
  }
  await observe?.prepareNetwork?.();
  const response = await open();
  try {
    if (!response.body) throw new CloudError(t("err.googleDownload"));
    const writable = await handle.createWritable();
    const total = byteTotal(response, size);
    await pump(response.body, writable, observe?.onProgress, total);
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
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
  tokenFor: TokenFor,
  host: DownloadHost,
  io: DriveDownloadIo,
  observe?: DownloadObserve,
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
    await saveGoogleBlob(item, host, io, observe);
    return;
  }

  const open = () => {
    const token = tokenFor("google");
    if (!token) throw new CloudError(t("err.download"));
    return io.openGoogleMedia(token, fileId);
  };

  const attempts: Array<() => Promise<void>> = [];
  if (method === "save-picker" || host.showSaveFilePicker) {
    attempts.push(async () => streamToPicker(open, host, fileName, item.size, observe));
  }
  const canUseSw =
    !isSafariLike(host.userAgent) &&
    (typeof host.serviceWorker === "function" || typeof host.postToWorker === "function");
  if (canUseSw && (method === "sw-stream" || method === "save-picker")) {
    attempts.push(async () => {
      await observe?.prepareNetwork?.();
      const response = await open();
      try {
        await streamToServiceWorker(response, host, fileName, item.mimeType, item.size, tokenFor, fileId, observe);
      } catch (error) {
        await cancelBody(response);
        throw error;
      }
    });
  }
  if (method === "opfs-share" || host.getDirectory) {
    attempts.push(async () => streamToOpfsAndShare(open, host, fileName, item.mimeType, item.size, observe));
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
  observe?: DownloadObserve,
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
        await observe?.prepareNetwork?.();
        const url = await io.microsoftDownloadUrl(token, ref.blobId);
        if (!url.startsWith("https:")) throw new CloudError(t("err.msNoUrl"));
        observe?.onHandoff?.();
        host.clickLink(url, item.fileName || "download", { newTab: true });
        return;
      }
      if (ref.provider === "google") {
        await saveGoogleFile(item, ref.blobId, tokenFor, host, io, observe);
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

/**
 * One download at a time. The view is set before any network wait so a click is visible
 * immediately. Save As is the next await, before token renewal. A browser handoff stays
 * on screen; a finished in-app save clears it.
 */
export async function runDownload(input: {
  item: DropRecord;
  getView: () => DownloadView | null;
  setView: (view: DownloadView | null) => void;
  tokenFor: TokenFor;
  renew: (provider: ProviderId) => Promise<void>;
  host?: DownloadHost;
  io?: DriveDownloadIo;
}): Promise<void> {
  if (input.getView()?.phase === "progress") return;
  const total = input.item.kind === "file" && input.item.size > 0 ? input.item.size : null;
  input.setView({ itemId: input.item.id, phase: "progress", loaded: 0, total, error: null });
  let prepared = false;
  const prepareNetwork = async () => {
    if (prepared) return;
    const providers = [...new Set(input.item.refs.map((ref) => ref.provider))];
    for (const provider of providers) await input.renew(provider);
    prepared = true;
  };
  try {
    await saveCloudFile(input.item, input.tokenFor, input.host, input.io, {
      prepareNetwork,
      onProgress(loaded, reported) {
        const view = input.getView();
        if (!view || view.itemId !== input.item.id || view.phase !== "progress") return;
        input.setView({
          ...view,
          loaded,
          total: typeof reported === "number" && reported > 0 ? reported : view.total,
        });
      },
      onHandoff() {
        const view = input.getView();
        if (!view || view.itemId !== input.item.id) return;
        input.setView({ ...view, phase: "handed-off", error: null });
      },
    });
    const view = input.getView();
    if (view?.itemId === input.item.id && view.phase === "progress") input.setView(null);
  } catch (error) {
    if (isUserCancel(error)) {
      if (input.getView()?.itemId === input.item.id) input.setView(null);
      return;
    }
    const message = error instanceof Error && error.message ? error.message : t("bubble.downloadFailed");
    const view = input.getView();
    input.setView({
      itemId: input.item.id,
      phase: "error",
      loaded: view?.itemId === input.item.id ? view.loaded : 0,
      total: view?.itemId === input.item.id ? view.total : total,
      error: message,
    });
    throw error instanceof CloudError ? error : asCloudError(error, message);
  }
}
