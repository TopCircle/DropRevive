import { t } from "@/lib/i18n";
import { renewToken } from "./drive-token";
import { assertOk, CloudError } from "./errors";
import { apiFetch as graphFetch, parseJson, xhrSend } from "./http";
import { readJson, writeJson } from "./secrets";
import { FOLDER_NAME, FOLDERS_KEY, type RemoteMeta, type UploadedObject } from "./types";
import {
  MICROSOFT_CHUNK_BYTES,
  RetryableUploadError,
  UPLOAD_ATTEMPTS,
  isRetryableUploadFailure,
  isRetryableUploadStatus,
  monotonicProgress,
  retryDelayMs,
  retryUploadRequest,
  startFromExpectedRanges,
  wait,
  type DriveUploadIo,
} from "./upload-retry";

export { MICROSOFT_CHUNK_BYTES };

const GRAPH = "https://graph.microsoft.com/v1.0";
export const SIMPLE_LIMIT = 4 * 1024 * 1024;
const CHUNK = MICROSOFT_CHUNK_BYTES;

type DriveItem = {
  id?: string;
  name?: string;
  lastModifiedDateTime?: string;
  folder?: unknown;
};

type DriveChildren = {
  value?: DriveItem[];
  "@odata.nextLink"?: string;
};

/** One retry through the Worker when Graph rejects the access token. No MSAL round trip. */
async function apiFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ status: number; text: string }> {
  const first = await graphFetch(url, token, init);
  if (first.status !== 401) return first;
  const next = await renewToken("microsoft", token);
  return graphFetch(url, next, init);
}

function folderMap(): Partial<Record<"google" | "microsoft", string>> {
  return readJson(FOLDERS_KEY, {});
}

function rememberFolder(id: string): void {
  writeJson(FOLDERS_KEY, { ...folderMap(), microsoft: id });
}

export function forgetMicrosoftFolder(): void {
  const next = folderMap();
  delete next.microsoft;
  writeJson(FOLDERS_KEY, next);
}

async function getItem(
  token: string,
  url: string,
): Promise<{ status: number; item: DriveItem | null; text: string }> {
  const { status, text } = await apiFetch(url, token);
  return { status, item: parseJson<DriveItem>(text), text };
}

export async function ensureMicrosoftFolder(token: string): Promise<string> {
  const cached = folderMap().microsoft;
  if (cached) {
    const probe = await getItem(token, `${GRAPH}/me/drive/items/${cached}?select=id,folder`);
    if (probe.status === 200 && probe.item?.id) return cached;
    forgetMicrosoftFolder();
  }
  const byPath = await getItem(
    token,
    `${GRAPH}/me/drive/root:/${FOLDER_NAME}?select=id,folder,name`,
  );
  if (byPath.status === 200 && byPath.item?.id) {
    rememberFolder(byPath.item.id);
    return byPath.item.id;
  }
  if (byPath.status !== 404) assertOk("microsoft", byPath.status, byPath.text);
  const created = await apiFetch(`${GRAPH}/me/drive/root/children`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: FOLDER_NAME,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });
  if (created.status === 409) {
    const again = await getItem(token, `${GRAPH}/me/drive/root:/${FOLDER_NAME}?select=id`);
    assertOk("microsoft", again.status, again.text);
    if (!again.item?.id) throw new CloudError(t("err.msFolderExists"));
    rememberFolder(again.item.id);
    return again.item.id;
  }
  assertOk("microsoft", created.status, created.text);
  const item = parseJson<DriveItem>(created.text);
  if (!item?.id) throw new CloudError(t("err.msNoFolder"));
  rememberFolder(item.id);
  return item.id;
}

/** Graph path of a shelf folder ("" = the DropRevive folder itself). */
function shelfPath(shelf?: string): string {
  return shelf ? `${FOLDER_NAME}/${encodeURIComponent(shelf)}` : FOLDER_NAME;
}

async function listChildren(
  token: string,
  first: string,
): Promise<{ items: DriveItem[]; complete: boolean } | null> {
  const items: DriveItem[] = [];
  let url: string | null = first;
  let complete = true;
  for (let page = 0; page < 8 && url; page += 1) {
    const { status, text } = await apiFetch(url, token);
    if (status === 404) return null;
    assertOk("microsoft", status, text);
    const json = parseJson<DriveChildren>(text);
    items.push(...(json?.value ?? []));
    url = json?.["@odata.nextLink"] ?? null;
    if (page === 7 && url) complete = false;
  }
  return { items, complete };
}

/** Metas in DropRevive and in each of its subfolders (the shelves), plus the shelf names. */
export async function listMicrosoftMetas(
  token: string,
): Promise<{ metas: RemoteMeta[]; shelves: string[]; complete: boolean }> {
  const select = "?$top=200&$select=id,name,lastModifiedDateTime,file,folder";
  const top = await listChildren(
    token,
    `${GRAPH}/me/drive/root:/${FOLDER_NAME}:/children${select}`,
  );
  if (!top) return { metas: [], shelves: [], complete: true };
  const metas: RemoteMeta[] = [];
  const shelves: string[] = [];
  let complete = top.complete;
  const take = (items: DriveItem[], shelf?: string) => {
    for (const item of items) {
      if (!item.id || item.folder || !item.name?.endsWith(".json") || !item.name.startsWith("d_"))
        continue;
      metas.push({
        id: item.id,
        name: item.name,
        modifiedTime: item.lastModifiedDateTime || "",
        ...(shelf ? { shelf } : {}),
      });
    }
  };
  take(top.items);
  for (const folder of top.items) {
    if (!folder.folder || !folder.id || !folder.name) continue;
    shelves.push(folder.name);
    const children = await listChildren(
      token,
      `${GRAPH}/me/drive/items/${folder.id}/children${select}`,
    );
    if (!children) continue;
    if (!children.complete) complete = false;
    take(children.items, folder.name);
  }
  return { metas, shelves, complete };
}

/** Folder id for a shelf; "conflictBehavior: fail" makes a racing second create reuse the first. */
export async function ensureMicrosoftShelf(token: string, shelf?: string): Promise<string> {
  const root = await ensureMicrosoftFolder(token);
  if (!shelf) return root;
  const created = await apiFetch(`${GRAPH}/me/drive/items/${root}/children`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: shelf, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  if (created.status !== 409) {
    assertOk("microsoft", created.status, created.text);
    const id = parseJson<DriveItem>(created.text)?.id;
    if (id) return id;
  }
  const found = await getItem(token, `${GRAPH}/me/drive/root:/${shelfPath(shelf)}?select=id`);
  assertOk("microsoft", found.status, found.text);
  if (!found.item?.id) throw new CloudError(t("err.msFolderExists"));
  return found.item.id;
}

export async function moveMicrosoftFile(
  token: string,
  itemId: string,
  folderId: string,
): Promise<void> {
  const { status, text } = await apiFetch(`${GRAPH}/me/drive/items/${itemId}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentReference: { id: folderId } }),
  });
  assertOk("microsoft", status, text);
}

/** Removes a shelf folder only when nothing is left in it. False means the folder is still there. */
export async function removeMicrosoftShelf(token: string, shelf: string): Promise<boolean> {
  const found = await getItem(token, `${GRAPH}/me/drive/root:/${shelfPath(shelf)}?select=id`);
  if (found.status === 404 || !found.item?.id) return true;
  const left = await listChildren(
    token,
    `${GRAPH}/me/drive/items/${found.item.id}/children?$top=1&$select=id`,
  );
  if (left?.items.length) return false;
  await deleteMicrosoftFile(token, found.item.id);
  return true;
}

/** Accepts only an https @microsoft.graph.downloadUrl. */
export function parseMicrosoftDownloadUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const url = (payload as { "@microsoft.graph.downloadUrl"?: unknown })["@microsoft.graph.downloadUrl"];
  if (typeof url !== "string") return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

export async function microsoftDownloadUrl(token: string, itemId: string): Promise<string> {
  return downloadUrl(token, itemId);
}

async function downloadUrl(token: string, itemId: string): Promise<string> {
  const { status, text } = await apiFetch(
    `${GRAPH}/me/drive/items/${itemId}?select=id,@microsoft.graph.downloadUrl`,
    token,
  );
  assertOk("microsoft", status, text);
  const url = parseMicrosoftDownloadUrl(parseJson(text));
  if (!url) throw new CloudError(t("err.msNoUrl"));
  return url;
}

export async function readMicrosoftText(token: string, itemId: string): Promise<string> {
  const url = await downloadUrl(token, itemId);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new CloudError(t("err.msMeta"));
    return await response.text();
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(t("err.msMetaCut"));
  }
}

export async function downloadMicrosoftBlob(token: string, itemId: string): Promise<Blob> {
  const url = await downloadUrl(token, itemId);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new CloudError(t("err.msFile"));
    return await response.blob();
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(t("err.msFileCut"));
  }
}

function asMicrosoftItem(
  json: DriveItem | null,
  missing: "err.msNoFile" | "err.msLargeDone",
): UploadedObject {
  if (!json?.id) throw new CloudError(t(missing));
  return {
    id: json.id,
    ...(json.lastModifiedDateTime ? { modifiedTime: json.lastModifiedDateTime } : {}),
  };
}

type SessionStatus = { item: UploadedObject } | { next: number };

async function queryMicrosoftOffset(
  fetchImpl: typeof fetch,
  uploadUrl: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SessionStatus> {
  const result = await retryUploadRequest(
    async () => {
      try {
        const response = await fetchImpl(uploadUrl, { method: "GET" });
        const text = await response.text();
        return { status: response.status, text };
      } catch (error) {
        if (isRetryableUploadFailure(error)) throw error;
        throw new RetryableUploadError(t("err.msLargeCut"));
      }
    },
    { sleep },
  );
  if (result.status === 200 || result.status === 201) {
    const json = parseJson<DriveItem & { nextExpectedRanges?: string[] }>(result.text);
    if (json?.id) return { item: asMicrosoftItem(json, "err.msLargeDone") };
    const next = startFromExpectedRanges(json?.nextExpectedRanges);
    if (next !== null) return { next };
    throw new CloudError(t("err.msLargeCut"));
  }
  assertOk("microsoft", result.status, result.text);
  throw new CloudError(t("err.msLargeCut"));
}

export async function uploadMicrosoftFile(input: {
  token: string;
  name: string;
  mime: string;
  body: Blob;
  shelf?: string;
  onProgress?: (ratio: number) => void;
  io?: DriveUploadIo;
}): Promise<UploadedObject> {
  const send = input.io?.xhrSend ?? xhrSend;
  const fetchImpl = input.io?.fetch ?? fetch;
  const sleep = input.io?.sleep ?? wait;
  const report = monotonicProgress(input.onProgress);
  let token = input.token;
  const path = `${GRAPH}/me/drive/root:/${shelfPath(input.shelf)}/${input.name}:/content`;
  if (input.body.size <= SIMPLE_LIMIT) {
    const result = await retryUploadRequest(
      async () => {
        const put = (access: string) =>
          send({
            url: path,
            method: "PUT",
            headers: { Authorization: `Bearer ${access}`, "Content-Type": input.mime },
            body: input.body,
            onProgress: report,
          });
        let out = await put(token);
        if (out.status === 401) {
          token = await renewToken("microsoft", token);
          out = await put(token);
        }
        return out;
      },
      { sleep },
    );
    assertOk("microsoft", result.status, result.text);
    return asMicrosoftItem(parseJson<DriveItem>(result.text), "err.msNoFile");
  }

  const openSession = (access: string) =>
    fetchImpl(
      `${GRAPH}/me/drive/root:/${shelfPath(input.shelf)}/${input.name}:/createUploadSession`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          item: { "@microsoft.graph.conflictBehavior": "replace", name: input.name },
        }),
      },
    );
  let sessionRes: Response;
  try {
    sessionRes = await openSession(token);
    if (sessionRes.status === 401) {
      token = await renewToken("microsoft", token);
      sessionRes = await openSession(token);
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(t("err.msLargeCut"));
  }
  const sessionText = await sessionRes.text();
  assertOk("microsoft", sessionRes.status, sessionText);
  const session = parseJson<{ uploadUrl?: string }>(sessionText);
  if (!session?.uploadUrl) throw new CloudError(t("err.msNoUpload"));
  const uploadUrl = session.uploadUrl;
  const total = input.body.size;
  let start = 0;
  let finished: UploadedObject | null = null;

  const applyStatus = (recovered: SessionStatus): "done" | "moved" | "same" => {
    if ("item" in recovered) {
      finished = recovered.item;
      report(1);
      return "done";
    }
    if (recovered.next > start) {
      start = recovered.next;
      report(start / total);
      return start >= total ? "done" : "moved";
    }
    return "same";
  };

  while (start < total && !finished) {
    let lastError: unknown;
    let advanced = false;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt - 1));
        const recovered = await queryMicrosoftOffset(fetchImpl, uploadUrl, sleep);
        const applied = applyStatus(recovered);
        if (applied === "done") break;
        if (applied === "moved") {
          advanced = true;
          break;
        }
      }
      if (start >= total) break;
      const end = Math.min(start + CHUNK, total);
      const chunk = input.body.slice(start, end);
      try {
        const result = await send({
          url: uploadUrl,
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
            "Content-Type": input.mime,
          },
          body: chunk,
          onProgress: (ratio) => report((start + ratio * (end - start)) / total),
        });
        if (result.status === 202) {
          const json = parseJson<{ nextExpectedRanges?: string[] }>(result.text);
          const next = startFromExpectedRanges(json?.nextExpectedRanges);
          start = next !== null && next > start ? next : end;
          report(start / total);
          advanced = true;
          break;
        }
        if (result.status >= 200 && result.status < 300) {
          finished = asMicrosoftItem(parseJson<DriveItem>(result.text), "err.msLargeDone");
          report(1);
          break;
        }
        // 416: range was wrong — ask the session, do not blindly repeat the same PUT.
        if (result.status === 416 && attempt < UPLOAD_ATTEMPTS - 1) {
          lastError = new CloudError(t("err.msLargeCut"));
          continue;
        }
        if (isRetryableUploadStatus(result.status) && attempt < UPLOAD_ATTEMPTS - 1) {
          lastError = new CloudError(t("err.msLargeCut"));
          continue;
        }
        assertOk("microsoft", result.status, result.text);
      } catch (error) {
        lastError = error;
        if (error instanceof CloudError && !isRetryableUploadFailure(error)) throw error;
        if (isRetryableUploadFailure(error) && attempt < UPLOAD_ATTEMPTS - 1) continue;
        throw error instanceof CloudError ? error : new CloudError(t("err.msLargeCut"));
      }
    }
    if (finished) break;
    if (advanced) continue;
    try {
      const recovered = await queryMicrosoftOffset(fetchImpl, uploadUrl, sleep);
      const applied = applyStatus(recovered);
      if (applied === "done") break;
      if (applied === "moved") continue;
    } catch {
      // Keep the original PUT failure if the status query also fails.
    }
    throw lastError instanceof CloudError ? lastError : new CloudError(t("err.msLargeCut"));
  }
  if (!finished) throw new CloudError(t("err.msLargeDone"));
  return finished;
}

export async function deleteMicrosoftFile(token: string, itemId: string): Promise<void> {
  const { status, text } = await apiFetch(`${GRAPH}/me/drive/items/${itemId}`, token, {
    method: "DELETE",
  });
  if (status === 404) return;
  assertOk("microsoft", status, text);
}
