import { t } from "@/lib/i18n";
import type { DropRecord } from "./types";

const DB_NAME = "droprevive";
const DB_VERSION = 1;

type StoreName = "kv" | "items" | "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t("err.idbOpen")));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t("err.idbIo")));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t("err.idbTx")));
    tx.onabort = () => reject(tx.error ?? new Error(t("err.idbAbort")));
  });
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(name, mode);
    const result = await run(tx.objectStore(name));
    await txDone(tx);
    return result;
  } finally {
    db.close();
  }
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | null> {
  try {
    const value = await withStore(store, "readonly", (objectStore) =>
      requestToPromise(objectStore.get(key) as IDBRequest<T | undefined>),
    );
    return value ?? null;
  } catch {
    return null;
  }
}

export async function idbSet(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  await withStore(store, "readwrite", (objectStore) => {
    objectStore.put(value, key);
  });
}

/** `null` means the database could not be read. Callers must not treat that as an empty history. */
export async function loadItems(): Promise<DropRecord[] | null> {
  try {
    const rows = await withStore("items", "readonly", (store) =>
      requestToPromise(store.getAll() as IDBRequest<DropRecord[]>),
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

export async function replaceItems(items: DropRecord[]): Promise<void> {
  await withStore("items", "readwrite", (store) => {
    store.clear();
    for (const item of items) store.put(item, item.id);
  });
}

export async function cacheBlob(key: string, blob: Blob): Promise<void> {
  if (blob.size > 10 * 1024 * 1024) return;
  try {
    await idbSet("blobs", key, blob);
  } catch {
    // Cache is optional. The cloud copy is the source of truth.
  }
}

export async function readCachedBlob(key: string): Promise<Blob | null> {
  const blob = await idbGet<Blob>("blobs", key);
  return blob instanceof Blob ? blob : null;
}

export async function clearItemCache(): Promise<void> {
  await withStore("items", "readwrite", (store) => {
    store.clear();
  });
  await withStore("blobs", "readwrite", (store) => {
    store.clear();
  });
}
