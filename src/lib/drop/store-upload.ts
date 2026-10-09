import { t } from "@/lib/i18n";
import { asCloudError, CloudError } from "./errors";
import { uploadGoogleFile } from "./google";
import { cacheBlob } from "./idb";
import { buildMeta } from "./meta";
import { uploadMicrosoftFile } from "./microsoft";
import { foldersFor } from "./reconcile";
import { invalidateSync, sortItems, type StoreGet, type StoreSet } from "./store-core";
import { tokenFor } from "./store-session";
import { SHELF_OPS } from "./store-sync";
import {
  PROVIDER_LABEL,
  type CloudRef,
  type DropRecord,
  type ProviderId,
  type Scope,
  type SendResult,
  type Settings,
  type UploadJob,
} from "./types";

/**
 * Drives a send goes to: the selected one, or every connected one for "全部". An
 * unconnected selection sends nowhere (no fallback), and `note` says what to connect.
 * An expired token still counts as connected: tokenFor renews it before the upload.
 */
export function sendTargets(provider: Scope["provider"], google: unknown, microsoft: unknown): { targets: ProviderId[]; note: string | null } {
  const connected = (["google", "microsoft"] as const).filter((id) => (id === "google" ? google : microsoft));
  if (provider === "all") {
    return connected.length ? { targets: connected, note: null } : { targets: [], note: t("err.needEither") };
  }
  return connected.includes(provider)
    ? { targets: [provider], note: null }
    : { targets: [], note: t("err.needProvider", { label: PROVIDER_LABEL[provider] }) };
}

type Draft =
  | { id: string; kind: "text"; text: string; size: number; label: string }
  | { id: string; kind: "file"; file: File; label: string; fileIndex: number };

function patchJob(set: StoreSet, get: StoreGet, id: string, patch: Partial<UploadJob>): void {
  set({
    jobs: get().jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
  });
}

async function uploadDraft(
  provider: ProviderId,
  token: string,
  draft: Draft,
  settings: Settings,
  shelf: string | undefined,
  set: StoreSet,
  get: StoreGet,
): Promise<{ ref: CloudRef; modifiedTime?: string }> {
  const jobId = `${draft.id}:${provider}`;
  const label = draft.label;
  set({
    jobs: [
      ...get().jobs,
      { id: jobId, label, provider, progress: 0.04, phase: "uploading" },
    ],
  });
  try {
    // Shelf subfolder (or DropRevive itself); created here if another drive has it but this one doesn't yet.
    const folderId = await SHELF_OPS[provider].folder(token, shelf);
    const put = (name: string, mime: string, body: Blob, onProgress: (ratio: number) => void) =>
      provider === "google"
        ? uploadGoogleFile({ token, folderId, name, mime, body, onProgress })
        : uploadMicrosoftFile({ token, name, mime, body, shelf, onProgress });
    let blobId: string | undefined;
    if (draft.kind === "file") {
      const uploaded = await put(`b_${draft.id}`, draft.file.type || "application/octet-stream", draft.file, (ratio) =>
        patchJob(set, get, jobId, { progress: 0.05 + ratio * 0.8 }),
      );
      blobId = uploaded.id;
    }
    const meta = buildMeta({
      id: draft.id,
      kind: draft.kind,
      createdAt: new Date().toISOString(),
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      size: draft.kind === "text" ? draft.size : draft.file.size,
      ...(draft.kind === "text" ? { text: draft.text } : {}),
      ...(draft.kind === "file"
        ? {
            fileName: draft.file.name || t("err.unnamed"),
            mimeType: draft.file.type || "application/octet-stream",
            ...(blobId ? { blobId, blobName: `b_${draft.id}` } : {}),
          }
        : {}),
    });
    const body = new Blob([JSON.stringify(meta)], { type: "application/json" });
    const metaName = `d_${draft.id}.json`;
    const metaUploaded = await put(metaName, "application/json", body, (ratio) =>
      patchJob(set, get, jobId, { progress: 0.86 + ratio * 0.14 }),
    );
    patchJob(set, get, jobId, { progress: 1, phase: "done" });
    return {
      ref: {
        provider,
        metaId: metaUploaded.id,
        metaName,
        ...(blobId ? { blobId } : {}),
        ...(shelf ? { shelf } : {}),
      },
      ...(metaUploaded.modifiedTime ? { modifiedTime: metaUploaded.modifiedTime } : {}),
    };
  } catch (error) {
    const message = asCloudError(error, t("err.send")).message;
    patchJob(set, get, jobId, { phase: "error", error: message });
    throw new CloudError(message);
  }
}

export async function sendDrafts(
  texts: string[],
  files: File[],
  scope: Scope,
  set: StoreSet,
  get: StoreGet,
): Promise<SendResult> {
  // A folder belongs to one drive, so "全部" never sends into a folder.
  const shelfId = scope.provider === "all" ? undefined : scope.shelfId || undefined;
  if (!navigator.onLine) {
    return { sent: 0, failed: texts.length + files.length, message: t("err.offlineSend") };
  }
  const choice = sendTargets(scope.provider, get().google, get().microsoft);
  if (!choice.targets.length) {
    return { sent: 0, failed: 0, message: choice.note || t("err.needDrive") };
  }
  const drafts: Draft[] = [];
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    drafts.push({
      id: crypto.randomUUID(),
      kind: "text",
      text: trimmed,
      size: new TextEncoder().encode(trimmed).byteLength,
      label: trimmed.split("\n")[0]?.slice(0, 42) || t("err.draftLabelText"),
    });
  }
  files.forEach((file, fileIndex) => {
    drafts.push({
      id: crypto.randomUUID(),
      kind: "file",
      file,
      fileIndex,
      label: file.name || t("err.draftLabelFile"),
    });
  });
  if (!drafts.length) return { sent: 0, failed: 0, message: t("err.needDraft") };

  invalidateSync();
  set({ busy: true, jobs: [], syncError: null });
  let sent = 0;
  let failed = 0;
  let textSent: boolean | undefined;
  const failedFileIndexes: number[] = [];
  const okProviders = new Set<ProviderId>();
  const failMessage = new Map<ProviderId, string>();
  try {
    for (const draft of drafts) {
      const createdAt = new Date().toISOString();
      const refs: CloudRef[] = [];
      const revs: DropRecord["revs"] = {};
      for (const provider of choice.targets) {
        try {
          const token = await tokenFor(provider, get);
          if (!token) throw new CloudError(t("err.providerAuth", { label: PROVIDER_LABEL[provider] }));
          const uploaded = await uploadDraft(provider, token, draft, get().settings, shelfId, set, get);
          refs.push(uploaded.ref);
          if (uploaded.modifiedTime) revs[provider] = uploaded.modifiedTime;
          okProviders.add(provider);
        } catch (error) {
          const message = asCloudError(error, t("err.send")).message;
          if (!failMessage.has(provider)) failMessage.set(provider, message);
        }
      }
      if (draft.kind === "text") textSent = textSent === undefined ? refs.length > 0 : textSent && refs.length > 0;
      if (!refs.length) {
        failed += 1;
        if (draft.kind === "file") failedFileIndexes.push(draft.fileIndex);
        continue;
      }
      const record: DropRecord = {
        id: draft.id,
        kind: draft.kind,
        createdAt,
        deviceId: get().settings.deviceId,
        deviceName: get().settings.deviceName,
        size: draft.kind === "text" ? draft.size : draft.file.size,
        refs,
        revs,
        folders: foldersFor(refs, shelfId),
        ...(draft.kind === "text" ? { text: draft.text } : {}),
        ...(draft.kind === "file"
          ? {
              fileName: draft.file.name || t("err.unnamed"),
              mimeType: draft.file.type || "application/octet-stream",
            }
          : {}),
      };
      set({ items: sortItems([record, ...get().items]) });
      if (draft.kind === "file") {
        const ref = refs.find((entry) => entry.blobId);
        if (ref?.blobId) await cacheBlob(`${ref.provider}:${ref.blobId}`, draft.file);
      }
      sent += 1;
      if (refs.length !== choice.targets.length) failed += 1;
    }
  } finally {
    set({ busy: false, jobs: [] });
    // The send invalidated any sync that was in flight. Run one more pass now that busy is clear.
    void get().sync();
  }

  const where = choice.targets.filter((provider) => okProviders.has(provider)).map((provider) => PROVIDER_LABEL[provider]).join(t("composer.and"));
  const bad = choice.targets
    .filter((provider) => failMessage.has(provider))
    .map((provider) => t("err.providerFailed", { label: PROVIDER_LABEL[provider], message: failMessage.get(provider) ?? "" }))
    .join(t("err.join"));
  let message: string;
  if (!sent) message = bad || t("err.noneSent");
  else if (bad && where) message = t("err.sentPartial", { where, bad });
  else if (bad) message = bad;
  else message = t("err.sent", { where });
  return {
    sent,
    failed,
    message,
    ...(textSent !== undefined ? { textSent } : {}),
    ...(failedFileIndexes.length ? { failedFileIndexes } : {}),
  };
}
