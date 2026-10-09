import { t } from "@/lib/i18n";
import { CloudError } from "./errors";
import { retryRead } from "./net-retry";

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
    return await retryRead(attempt, { method: init?.method, online: () => typeof navigator === "undefined" || navigator.onLine !== false });
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
}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(input.method, input.url);
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      request.setRequestHeader(key, value);
    }
    request.upload.onprogress = (event) => {
      if (!input.onProgress || !event.lengthComputable || event.total <= 0) return;
      input.onProgress(event.loaded / event.total);
    };
    request.onload = () => resolve({ status: request.status, text: request.responseText ?? "" });
    request.onerror = () => reject(new CloudError(t("err.uploadCut")));
    request.onabort = () => reject(new CloudError(t("err.uploadCancel")));
    request.send(input.body ?? null);
  });
}
