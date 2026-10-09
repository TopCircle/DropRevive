import { useSyncExternalStore } from "react";
import { en } from "./packs/en";
import { zhMessages } from "./packs/zh";
import type { LanguagePack, MessageKey } from "./types";

export type { LanguagePack, MessageKey, Messages } from "./types";

/**
 * Built-in packs are Chinese and English. To add a language: write
 * `packs/<id>.ts` whose `messages` satisfies `Messages`, then `registerPack`
 * it here. Settings lists every registered pack.
 */

const STORAGE_KEY = "droprevive.locale";

const packs = new Map<string, LanguagePack>();

export function registerPack(pack: LanguagePack): void {
  packs.set(pack.id, pack);
}

registerPack({ id: "zh", label: "中文", htmlLang: "zh-CN", messages: zhMessages });
registerPack(en);

function fallbackPack(): LanguagePack {
  return packs.get("zh") ?? [...packs.values()][0]!;
}

function savedOrDetected(): string {
  if (typeof localStorage === "undefined") return "zh";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && packs.has(saved)) return saved;
  } catch {
    // Private mode can throw. Fall through to the browser language.
  }
  const lang = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("en") && packs.has("en")) return "en";
  return "zh";
}

let current = savedOrDetected();
if (typeof localStorage !== "undefined") writeStoredLocale(current);
const listeners = new Set<() => void>();

export function listPacks(): LanguagePack[] {
  return [...packs.values()];
}

export function getLocale(): string {
  return current;
}

export function getPack(id = current): LanguagePack {
  return packs.get(id) ?? fallbackPack();
}

function writeStoredLocale(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode can throw. The choice still applies until reload.
  }
  // The static service worker cannot import this module. A cookie travels with navigations.
  try {
    if (typeof document === "undefined") return;
    document.cookie = `${STORAGE_KEY}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // The worker then uses Accept-Language.
  }
}

export function setLocale(id: string): void {
  if (!packs.has(id) || id === current) return;
  current = id;
  writeStoredLocale(id);
  for (const listener of listeners) listener();
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (vars[key] == null ? "" : String(vars[key])));
}

/** Translate `key` in the active pack. Missing keys fall back to Chinese, then the key itself. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const message = getPack().messages[key] ?? fallbackPack().messages[key] ?? key;
  return fill(message, vars);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribes the component to the active language. Server render stays Chinese. */
export function useI18n(): { t: typeof t; locale: string } {
  const locale = useSyncExternalStore(subscribe, getLocale, () => "zh");
  return { t, locale };
}
