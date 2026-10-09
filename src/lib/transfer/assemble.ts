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
