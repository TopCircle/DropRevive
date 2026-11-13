import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openReceiveSink, type WritableLike } from "./receive-sink.ts";

function memoryWritable(): WritableLike & { chunks: Uint8Array[]; closed: boolean; aborted: boolean } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    closed: false,
    aborted: false,
    write(data) {
      chunks.push(data.slice());
    },
    close() {
      this.closed = true;
    },
    abort() {
      this.aborted = true;
    },
  };
}

describe("openReceiveSink", () => {
  it("returns null when the host has no disk API", async () => {
    assert.equal(await openReceiveSink({ name: "a.bin" }, {}), null);
  });

  it("writes through showSaveFilePicker and does not pre-allocate", async () => {
    const writable = memoryWritable();
    let suggested = "";
    const sink = await openReceiveSink(
      { name: "photo.png" },
      {
        showSaveFilePicker: async (options) => {
          suggested = options.suggestedName;
          return { createWritable: async () => writable };
        },
      },
    );
    assert.ok(sink);
    assert.equal(suggested, "photo.png");
    await sink!.write(Uint8Array.from([1, 2, 3]));
    await sink!.close();
    assert.deepEqual(Array.from(writable.chunks[0]!), [1, 2, 3]);
    assert.equal(writable.closed, true);
  });

  it("returns null when the user cancels the picker", async () => {
    const error = new Error("cancel");
    error.name = "AbortError";
    const sink = await openReceiveSink(
      { name: "a.bin" },
      {
        showSaveFilePicker: async () => {
          throw error;
        },
      },
    );
    assert.equal(sink, null);
  });

  it("falls back to the Origin Private File System when there is no picker", async () => {
    const writable = memoryWritable();
    let dirName = "";
    const sink = await openReceiveSink(
      { name: "a.bin" },
      {
        storage: {
          getDirectory: async () => ({
            getDirectoryHandle: async (name) => {
              dirName = name;
              return {
                getFileHandle: async () => ({ createWritable: async () => writable }),
              };
            },
          }),
        },
      },
    );
    assert.ok(sink);
    assert.equal(dirName, "droprevive-receive");
    await sink!.write(Uint8Array.from([9]));
    assert.equal(writable.chunks.length, 1);
  });
});
