/*
 * Public OAuth client IDs. They come from the Worker (GOOGLE_CLIENT_ID / MS_CLIENT_ID) through
 * the root route's loader, which calls applyClientConfig before anything renders; the build
 * values (VITE_*) are only the starting point and fallback. These are live bindings: every
 * importer sees the applied values.
 */
export let GOOGLE_CLIENT_ID = (import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? "").trim();
export let MS_CLIENT_ID = (import.meta.env?.VITE_MS_CLIENT_ID ?? "").trim();

export let googleConfigured = GOOGLE_CLIENT_ID.length > 0;
export let microsoftConfigured = MS_CLIENT_ID.length > 0;

/**
 * Use what the Worker resolved: the IDs (Worker value, else build value) and whether each drive
 * can sign in (ID + secret + cookie key + origin; runtime-config drivesEnabled). A drive whose ID
 * is known but is not enabled keeps its ID, so a stored session still matches once it is enabled
 * again, but shows as not configured. Missing flags (an older Worker) mean "enabled if it has an ID".
 */
export function applyClientConfig(
  config: { googleClientId?: string; msClientId?: string; googleEnabled?: boolean; msEnabled?: boolean } | null | undefined,
): void {
  if (!config) return;
  GOOGLE_CLIENT_ID = (config.googleClientId ?? "").trim();
  MS_CLIENT_ID = (config.msClientId ?? "").trim();
  googleConfigured = GOOGLE_CLIENT_ID.length > 0 && config.googleEnabled !== false;
  microsoftConfigured = MS_CLIENT_ID.length > 0 && config.msEnabled !== false;
}

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const MS_SCOPES = ["User.Read", "Files.ReadWrite", "offline_access"] as const;

export function authFailure(error: unknown): { code: string; description: string } {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = String(record.code ?? record.error ?? record.errorCode ?? record.name ?? "error");
    const description = String(
      record.error_description ?? record.errorMessage ?? record.message ?? record.error_uri ?? "",
    );
    return { code, description };
  }
  return { code: "error", description: error instanceof Error ? error.message : String(error) };
}
