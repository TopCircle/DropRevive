import { t } from "@/lib/i18n";
import { PROVIDER_LABEL, type ProviderId } from "./types";

export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudError";
  }
}

export function asCloudError(error: unknown, fallback: string): CloudError {
  if (error instanceof CloudError) return error;
  if (error instanceof Error && error.message) return new CloudError(error.message);
  return new CloudError(fallback);
}

export function explainStatus(provider: ProviderId, status: number, text: string): string {
  const label = PROVIDER_LABEL[provider];
  const raw = text.toLowerCase();
  if (
    status === 401 ||
    raw.includes("invalid_grant") ||
    raw.includes("invalidauthenticationtoken") ||
    raw.includes("unauthenticated")
  ) {
    return t("err.auth", { label });
  }
  if (status === 403 && (raw.includes("access_denied") || raw.includes("insufficient"))) {
    return t("err.permission", { label });
  }
  if (
    raw.includes("storagequotaexceeded") ||
    raw.includes("quotalimitreached") ||
    raw.includes("insufficient space") ||
    status === 507
  ) {
    return t("err.quota", { label });
  }
  if (status === 429 || raw.includes("ratelimit") || raw.includes("userratelimitexceeded")) {
    return t("err.rate", { label });
  }
  if (status >= 500) return t("err.server", { label });
  if (status === 404) return t("err.missing", { label });
  return t("err.rejected", { label, status });
}

export function assertOk(
  provider: ProviderId,
  status: number,
  text: string,
  ok: (status: number) => boolean = (code) => code >= 200 && code < 300,
): void {
  if (!ok(status)) throw new CloudError(explainStatus(provider, status, text));
}
