import { idbGet, idbSet } from "./idb";

const KEY_ID = "aes-key";

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>("kv", KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await idbSet("kv", KEY_ID, key);
  return key;
}

async function seal(value: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  const packed = new Uint8Array(iv.byteLength + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.byteLength);
  return bytesToB64(packed);
}

async function open(payload: string): Promise<string | null> {
  try {
    const packed = b64ToBytes(payload);
    if (packed.byteLength < 13) return null;
    const key = await getKey();
    const iv = packed.slice(0, 12);
    const data = packed.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function saveSecret(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  try {
    const sealed = await seal(json);
    localStorage.setItem(key, `v1:${sealed}`);
  } catch {
    // A bearer that cannot be sealed must not land as plaintext. The in-memory
    // session still works until reload; the next successful seal overwrites.
    localStorage.removeItem(key);
  }
}

export async function loadSecret<T>(key: string): Promise<T | null> {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    if (raw.startsWith("plain:")) return JSON.parse(raw.slice(6)) as T;
    if (raw.startsWith("v1:")) {
      const json = await open(raw.slice(3));
      if (!json) return null;
      return JSON.parse(json) as T;
    }
  } catch {
    return null;
  }
  return null;
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}
