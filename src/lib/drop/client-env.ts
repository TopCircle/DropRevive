export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
export const MS_CLIENT_ID = (import.meta.env.VITE_MS_CLIENT_ID ?? "").trim();

export const googleConfigured = GOOGLE_CLIENT_ID.length > 0;
export const microsoftConfigured = MS_CLIENT_ID.length > 0;

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
