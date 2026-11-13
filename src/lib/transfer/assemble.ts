import { StreamingSha256 } from "./sha256.ts";

export class FileAssembler {
  readonly id: string;
  readonly size: number;
  private readonly buffer: Uint8Array;
  private expected = 0;

  constructor(input: { id: string; size: number }) {
    if (!Number.isInteger(input.size) || input.size < 0 || input.size > 32 * 1024 * 1024) throw new Error("bad size");
    this.id = input.id;
    this.size = input.size;
    this.buffer = new Uint8Array(input.size);
  }

  push(offset: number, bytes: Uint8Array): boolean {
    if (bytes.byteLength < 1) throw new Error("empty chunk");
    if (offset !== this.expected) throw new Error("noncontiguous");
    if (offset + bytes.byteLength > this.size) throw new Error("chunk out of range");
    this.buffer.set(bytes, offset);
    this.expected += bytes.byteLength;
    return this.expected === this.size;
  }

  bytes(): Uint8Array {
    return this.buffer;
  }
}

export type ByteSink = {
  write(bytes: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?: () => Promise<void> | void;
};

/**
 * Receives contiguous chunks without pre-allocating the whole file.
 * A sink (file on disk) is required above 32 MiB; smaller files may live in memory.
 */
export class StreamAssembler {
  readonly id: string;
  readonly size: number;
  private expected = 0;
  private readonly sha = new StreamingSha256();
  private readonly sink: ByteSink | null;
  private readonly buffer: Uint8Array | null;
  private closed = false;

  constructor(input: { id: string; size: number; sink?: ByteSink }) {
    if (!Number.isInteger(input.size) || input.size < 0) throw new Error("bad size");
    this.id = input.id;
    this.size = input.size;
    if (input.sink) {
      this.sink = input.sink;
      this.buffer = null;
    } else {
      if (input.size > 32 * 1024 * 1024) throw new Error("bad size");
      this.sink = null;
      this.buffer = new Uint8Array(input.size);
    }
  }

  get offset(): number {
    return this.expected;
  }

  async push(offset: number, bytes: Uint8Array): Promise<boolean> {
    if (this.closed) throw new Error("closed");
    if (bytes.byteLength < 1) throw new Error("empty chunk");
    if (offset !== this.expected) throw new Error("noncontiguous");
    if (offset + bytes.byteLength > this.size) throw new Error("chunk out of range");
    this.sha.update(bytes);
    if (this.sink) await this.sink.write(bytes);
    else this.buffer!.set(bytes, offset);
    this.expected += bytes.byteLength;
    return this.expected === this.size;
  }

  bytes(): Uint8Array {
    if (!this.buffer) throw new Error("streamed");
    return this.buffer;
  }

  hex(): string {
    if (this.expected !== this.size) throw new Error("incomplete");
    return this.sha.hex();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sink) await this.sink.close();
  }

  async abort(): Promise<void> {
    this.closed = true;
    if (this.sink?.abort) await this.sink.abort();
  }
}

/** In-memory sink used by tests and as a stand-in when the host has no disk API. */
export function memorySink(): ByteSink & { chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write(bytes) {
      chunks.push(bytes.slice());
    },
    close() {},
    abort() {
      chunks.length = 0;
    },
  };
}
