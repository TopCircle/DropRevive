import { CODE_ALPHABET, CODE_LENGTH } from "./limits.ts";

export function generateCode(readBytes: () => Uint8Array): string {
  const alphabet = CODE_ALPHABET;
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = readBytes();
    for (const byte of bytes) {
      code += alphabet[byte % alphabet.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

export function isRoomCode(value: string): boolean {
  if (value.length !== CODE_LENGTH) return false;
  return [...value].every((char) => CODE_ALPHABET.includes(char));
}
