import { t } from "@/lib/i18n";
import { CloudError } from "./errors";
import { retryRead } from "./net-retry";
import {
  RetryableUploadError,
  UPLOAD_STALL_MS,
  UPLOAD_TIMEOUT_MS,
  type XhrSendResult,
} from "./upload-retry";

export async function apiFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ status: number; text: string }> {
  const attempt = async () => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    return { status: response.status, text };
  };
  try {
    // No response at all: a read gets one quiet retry while the browser says it's online.
    return await retryRead(attempt, {
      method: init?.method,
      online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    });
  } catch {
    throw new CloudError(t("err.net"));
  }
}

export function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function xhrSend(input: {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: XMLHttpRequestBodyInit | null;
  onProgress?: (ratio: number) => void;
  timeoutMs?: number;
  stallMs?: number;
}): Promise<XhrSendResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const timeoutMs = input.timeoutMs ?? UPLOAD_TIMEOUT_MS;
    const stallMs = input.stallMs ?? UPLOAD_STALL_MS;
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let abortedForStall = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      fn();
    };

    const armStall = () => {
      clearTimeout(stallTimer);
      if (stallMs <= 0) return;
      stallTimer = setTimeout(() => {
        abortedForStall = true;
        request.abort();
      }, stallMs);
    };

    request.open(input.method, input.url);
    request.timeout = timeoutMs > 0 ? timeoutMs : 0;
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      request.setRequestHeader(key, value);
    }
    request.upload.onprogress = (event) => {
      armStall();
      if (!input.onProgress || !event.lengthComputable || event.total <= 0) return;
      input.onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      finish(() =>
        resolve({
          status: request.status,
          text: request.responseText ?? "",
          header: (name) => request.getResponseHeader(name),
        }),
      );
    request.onerror = () => finish(() => reject(new RetryableUploadError(t("err.uploadCut"))));
    request.ontimeout = () => finish(() => reject(new RetryableUploadError(t("err.uploadCut"))));
    request.onabort = () =>
      finish(() =>
        reject(
          abortedForStall
            ? new RetryableUploadError(t("err.uploadCut"))
            : new CloudError(t("err.uploadCancel")),
        ),
      );
    armStall();
    request.send(input.body ?? null);
  });
}
