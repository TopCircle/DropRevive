import { formatDistanceToNow } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { getPack, t } from "@/lib/i18n";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("time.unknown");
  const locale = getPack().htmlLang.toLowerCase().startsWith("zh") ? zhCN : enUS;
  return formatDistanceToNow(date, { addSuffix: true, locale });
}

export function guessDeviceName(): string {
  if (typeof navigator === "undefined") return t("device.this");
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return t("device.iphone");
  if (/iPad/i.test(ua)) return t("device.ipad");
  if (/Android/i.test(ua)) return t("device.android");
  if (/Macintosh|Mac OS/i.test(ua)) return t("device.mac");
  if (/Windows/i.test(ua)) return t("device.windows");
  if (/Linux/i.test(ua)) return t("device.linux");
  return t("device.this");
}
