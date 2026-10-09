import { t } from "@/lib/i18n";
import { guessDeviceName } from "./format";
import type { Settings, ThemeMode } from "./types";

export const INITIAL_SETTINGS: Settings = {
  deviceId: "",
  deviceName: t("device.this"),
  googleClientId: "",
  microsoftClientId: "",
  theme: "system",
};

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function normalizeSettings(raw: unknown): Settings {
  const source = raw && typeof raw === "object" ? (raw as Partial<Settings>) : {};
  const theme: ThemeMode =
    source.theme === "light" || source.theme === "dark" || source.theme === "system"
      ? source.theme
      : "system";
  const deviceName =
    typeof source.deviceName === "string" && source.deviceName.trim()
      ? source.deviceName.trim().slice(0, 40)
      : guessDeviceName();
  return {
    deviceId: typeof source.deviceId === "string" && source.deviceId ? source.deviceId : crypto.randomUUID(),
    deviceName,
    googleClientId: typeof source.googleClientId === "string" ? source.googleClientId : "",
    microsoftClientId: typeof source.microsoftClientId === "string" ? source.microsoftClientId : "",
    theme,
  };
}
