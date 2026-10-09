import { t } from "@/lib/i18n";
import { CloudError } from "./errors";
import { trashGoogleFile } from "./google";
import { deleteMicrosoftFile } from "./microsoft";
import { readJson, writeJson } from "./secrets";
import { invalidateSync, type StoreGet, type StoreSet } from "./store-core";
import { tokenFor } from "./store-session";
import { OUTBOX_KEY, PROVIDER_LABEL, type CloudRef, type OutboxEntry } from "./types";

function readOutbox(): OutboxEntry[] {
  const raw = readJson<OutboxEntry[]>(OUTBOX_KEY, []);
  return Array.isArray(raw) ? raw.filter((entry) => Array.isArray(entry?.refs)) : [];
}

async function deleteRef(ref: CloudRef, token: string): Promise<void> {
  if (ref.provider === "google") {
    if (ref.blobId) await trashGoogleFile(token, ref.blobId);
    await trashGoogleFile(token, ref.metaId);
    return;
  }
  if (ref.blobId) await deleteMicrosoftFile(token, ref.blobId);
  await deleteMicrosoftFile(token, ref.metaId);
}

export async function replayOutbox(get: StoreGet): Promise<void> {
  const entries = readOutbox();
  if (!entries.length) return;
  const left: OutboxEntry[] = [];
  for (const entry of entries) {
    const refsLeft: CloudRef[] = [];
    for (const ref of entry.refs) {
      try {
        const token = await tokenFor(ref.provider, get);
        if (token) {
          await deleteRef(ref, token);
          continue;
        }
        refsLeft.push(ref);
      } catch {
        refsLeft.push(ref);
      }
    }
    if (refsLeft.length) left.push({ refs: refsLeft });
  }
  writeJson(OUTBOX_KEY, left);
}

export /** Deletes in the cloud first (Drive trash / OneDrive recycle bin); an item leaves this device only once every copy is gone. */
async function removeItems(ids: string[], set: StoreSet, get: StoreGet): Promise<string | null> {
  const doomed = get().items.filter((item) => ids.includes(item.id));
  if (!doomed.length) return null;
  if (!navigator.onLine) throw new CloudError(t("err.offlineDelete"));
  set({ busy: true });
  const left = new Map<string, CloudRef[]>();
  try {
    for (const item of doomed) {
      const kept: CloudRef[] = [];
      for (const ref of item.refs) {
        try {
          const token = await tokenFor(ref.provider, get);
          if (!token) throw new CloudError(t("err.providerOff", { label: PROVIDER_LABEL[ref.provider] }));
          await deleteRef(ref, token);
        } catch {
          kept.push(ref);
        }
      }
      if (kept.length) left.set(item.id, kept);
    }
  } finally {
    invalidateSync();
    const gone = ids.filter((id) => !left.has(id));
    set({
      busy: false,
      items: get()
        .items.filter((item) => !gone.includes(item.id))
        .map((item) => (left.has(item.id) ? { ...item, refs: left.get(item.id) ?? item.refs } : item)),
      selected: get().selected.filter((id) => !gone.includes(id)),
    });
    void get().sync();
  }
  if (left.size) throw new CloudError(t("err.deleteKept"));
  return null;
}
