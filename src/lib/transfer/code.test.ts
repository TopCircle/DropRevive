import assert from "node:assert/strict";
import test from "node:test";
import { CODE_ALPHABET, CODE_LENGTH } from "./limits.ts";
import { generateCode, isRoomCode } from "./code.ts";

test("generateCode uses the unambiguous alphabet and fixed length", () => {
  const bytes = Uint8Array.from([0, 31, 32, 255, 1, 2, 3, 4]);
  const code = generateCode(() => bytes);
  assert.equal(code.length, CODE_LENGTH);
  assert.equal(isRoomCode(code), true);
  for (const char of code) assert.equal(CODE_ALPHABET.includes(char), true);
});

test("isRoomCode rejects lookalikes and the wrong length", () => {
  assert.equal(isRoomCode("0OIL1"), false);
  assert.equal(isRoomCode("ABCDEFG"), false);
  assert.equal(isRoomCode("ABCDEFGH"), true);
});
