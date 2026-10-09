import assert from "node:assert/strict";
import test from "node:test";
import { FileAssembler } from "./assemble.ts";

test("assembler accepts only the next contiguous offset", () => {
  const file = new FileAssembler({ id: "f1", size: 5 });
  assert.throws(() => file.push(3, Uint8Array.from([4, 5])));
  assert.equal(file.push(0, Uint8Array.from([1, 2])), false);
  assert.throws(() => file.push(0, Uint8Array.from([1, 2])));
  assert.throws(() => file.push(1, Uint8Array.from([9])));
  assert.equal(file.push(2, Uint8Array.from([3, 4, 5])), true);
  assert.deepEqual(Array.from(file.bytes()), [1, 2, 3, 4, 5]);
});

test("assembler rejects a chunk past the end", () => {
  const file = new FileAssembler({ id: "f1", size: 2 });
  assert.throws(() => file.push(1, Uint8Array.from([1, 2])));
  assert.throws(() => new FileAssembler({ id: "f1", size: 32 * 1024 * 1024 + 1 }));
});
