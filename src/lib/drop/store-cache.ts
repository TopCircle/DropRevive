import { t } from "@/lib/i18n";
import { CloudError } from "./errors";
import { downloadGoogleBlob } from "./google";
import { cacheBlob, readCachedBlob, replaceItems } from "./idb";
import { downloadMicrosoftBlob } from "./microsoft";
import { saveSecret } from "./secrets";
import type { StoreGet, StoreSet } from "./store-core";
import { tokenFor } from "./store-session";
import { PROVIDER_LABEL, TOKENS_KEY, type DropRecord, type TokenBag } from "./types";

/** What this device keeps: the item list and sessions (in order), cached blobs, the preview URL. */

let previewUrl: string | null = null;
let persistChain: Promise<void> = Promise.resolve();
let localReadable = true;

/** False when the saved history could not be opened at load; the first non-empty list re-enables saving. */
export function setLocalReadable(readable: boolean): void {
  localReadable = readable;
}

export function queuePersist(items: DropRecord[], set: StoreSet): void {
  if (!localReadable) {
    if (items.length === 0) return;
    localReadable = true;
  }
  const snapshot = items;
  persistChain = persistChain
    .then(() => replaceItems(snapshot))
    .catch(() => {
      set({
        syncError: t("err.historyWrite"),
      });
    });
}

/** Save the sessions to the encrypted token store, after any write already queued. */
export function queueSecret(bag: TokenBag): void {
  persistChain = persistChain.then(() => saveSecret(TOKENS_KEY, bag)).catch(() => undefined);
}

/** Resolves once every queued write has settled. */
export function persisted(): Promise<void> {
  return persistChain;
}

export function setPreviewUrl(url: string | null): void {
  previewUrl = url;
}

export function revokePreview(): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

export function mimeOf(item: DropRecord): string {
  const name = item.fileName || "";
  return (
    item.mimeType ||
    (/\.png$/i.test(name)
      ? "image/png"
      : /\.jpe?g$/i.test(name)
        ? "image/jpeg"
        : /\.gif$/i.test(name)
          ? "image/gif"
          : /\.webp$/i.test(name)
            ? "image/webp"
            : /\.pdf$/i.test(name)
              ? "application/pdf"
              : "")
  );
}

export async function fetchBlob(item: DropRecord, get: StoreGet): Promise<Blob> {
  const withBlob = item.refs.filter((entry) => entry.blobId);
  if (!withBlob.length) throw new CloudError(t("err.noBlob"));
  for (const entry of withBlob) {
    const cached = await readCachedBlob(`${entry.provider}:${entry.blobId}`);
    if (cached) return cached;
  }
  if (!navigator.onLine) throw new CloudError(t("err.offlineFile"));
  const connected = withBlob.filter((entry) => (entry.provider === "google" ? get().google : get().microsoft));
  if (!connected.length) {
    throw new CloudError(t("err.providerNoDownload", { label: PROVIDER_LABEL[withBlob[0]!.provider] }));
  }
  let last: unknown;
  for (const ref of connected) {
    try {
      const token = await tokenFor(ref.provider, get);
      if (!token || !ref.blobId) throw new CloudError(t("err.providerNoDownload", { label: PROVIDER_LABEL[ref.provider] }));
      const blob =
        ref.provider === "google"
          ? await downloadGoogleBlob(token, ref.blobId)
          : await downloadMicrosoftBlob(token, ref.blobId);
      await cacheBlob(`${ref.provider}:${ref.blobId}`, blob);
      return blob;
    } catch (error) {
      last = error;
    }
  }
  if (last instanceof CloudError) throw last;
  throw new CloudError(t("err.download"));
}
