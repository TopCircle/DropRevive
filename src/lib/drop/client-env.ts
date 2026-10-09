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

/** Use the IDs the Worker resolved (Worker value, else build value). Empty means not configured. */
export function applyClientConfig(config: { googleClientId?: string; msClientId?: string } | null | undefined): void {
  if (!config) return;
  GOOGLE_CLIENT_ID = (config.googleClientId ?? "").trim();
  MS_CLIENT_ID = (config.msClientId ?? "").trim();
  googleConfigured = GOOGLE_CLIENT_ID.length > 0;
  microsoftConfigured = MS_CLIENT_ID.length > 0;
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
