import type { Messages } from "./packs/zh";

export type { Messages, MessageKey } from "./packs/zh";

/** One language pack. `messages` must cover every key in the Chinese pack. */
export type LanguagePack = {
  id: string;
  /** Native name shown in Settings, for example 中文 or English. */
  label: string;
  htmlLang: string;
  messages: Messages;
};
