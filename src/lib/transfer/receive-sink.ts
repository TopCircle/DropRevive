import type { ByteSink } from "./assemble.ts";

/** The subset of the File System Access / OPFS APIs this helper needs, so tests can fake them. */
export type WritableLike = {
  write(data: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort(): Promise<void> | void;
};

export type ReceiveSinkHost = {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableLike> }>;
  storage?: {
    getDirectory?: () => Promise<{
      getDirectoryHandle: (
        name: string,
        options: { create: boolean },
      ) => Promise<{
        getFileHandle: (name: string, options: { create: boolean }) => Promise<{ createWritable: () => Promise<WritableLike> }>;
      }>;
    }>;
  };
};

function asSink(writable: WritableLike): ByteSink {
  return {
    write: (bytes) => writable.write(bytes),
    close: () => writable.close(),
    abort: () => writable.abort(),
  };
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: string }).name === "AbortError";
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-()\u4e00-\u9fff]+/g, "_").slice(0, 80) || "file";
}

/**
 * Open a sequential disk sink without pre-allocating the file.
 * Prefers showSaveFilePicker; falls back to the Origin Private File System; returns null if the user
 * cancels or neither API exists.
 */
export async function openReceiveSink(file: { name: string }, host: ReceiveSinkHost = globalThis as unknown as ReceiveSinkHost): Promise<ByteSink | null> {
  if (typeof host.showSaveFilePicker === "function") {
    try {
      const handle = await host.showSaveFilePicker({ suggestedName: file.name });
      return asSink(await handle.createWritable());
    } catch (error) {
      if (isAbort(error)) return null;
    }
  }
  const getDirectory = host.storage?.getDirectory;
  if (typeof getDirectory === "function") {
    try {
      const root = await getDirectory.call(host.storage);
      const dir = await root.getDirectoryHandle("droprevive-receive", { create: true });
      const handle = await dir.getFileHandle(`${Date.now()}-${safeName(file.name)}`, { create: true });
      return asSink(await handle.createWritable());
    } catch {
      return null;
    }
  }
  return null;
}
