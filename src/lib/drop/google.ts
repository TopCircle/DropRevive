import { t } from "@/lib/i18n";
import { renewToken } from "./drive-token";
import { assertOk, CloudError } from "./errors";
import { apiFetch as driveFetch, parseJson, xhrSend } from "./http";
import { readJson, writeJson } from "./secrets";
import { FOLDER_NAME, FOLDERS_KEY, type RemoteMeta, type UploadedObject } from "./types";
import {
  GOOGLE_CHUNK_BYTES,
  UPLOAD_ATTEMPTS,
  isRetryableUploadFailure,
  isRetryableUploadStatus,
  monotonicProgress,
  nextByteFromGoogleRange,
  retryDelayMs,
  retryUploadRequest,
  wait,
  type DriveUploadIo,
  type XhrSendFn,
  type XhrSendResult,
} from "./upload-retry";

export { GOOGLE_CHUNK_BYTES };

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const FIVE_MB = 5 * 1024 * 1024;

type DriveFile = {
  id?: string;
  name?: string;
  modifiedTime?: string;
  parents?: string[];
};

type DriveList = {
  files?: DriveFile[];
  nextPageToken?: string;
};

/** One retry through the Worker when Drive rejects the access token. No browser sign-in popup. */
async function apiFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ status: number; text: string }> {
  const first = await driveFetch(url, token, init);
  if (first.status !== 401) return first;
  const next = await renewToken("google", token);
  return driveFetch(url, next, init);
}

function folderMap(): Partial<Record<"google" | "microsoft", string>> {
  return readJson(FOLDERS_KEY, {});
}

function rememberFolder(id: string): void {
  writeJson(FOLDERS_KEY, { ...folderMap(), google: id });
}

export function forgetGoogleFolder(): void {
  const next = folderMap();
  delete next.google;
  writeJson(FOLDERS_KEY, next);
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

function inAny(parents: string[]): string {
  return `(${parents.map((id) => `'${id}' in parents`).join(" or ")})`;
}

/** Folders matching `where`, oldest first. */
async function listFolders(token: string, where: string): Promise<{ id: string; name: string }[]> {
  const q = `mimeType = '${FOLDER_MIME}' and trashed = false and ${where}`;
  const url = `${DRIVE}/files?pageSize=200&orderBy=createdTime&fields=files(id,name)&q=${encodeURIComponent(q)}`;
  const { status, text } = await apiFetch(url, token);
  assertOk("google", status, text);
  return (parseJson<DriveList>(text)?.files ?? []).flatMap((file) =>
    file.id ? [{ id: file.id, name: file.name || "" }] : [],
  );
}

async function listFolderIds(token: string): Promise<string[]> {
  return (await listFolders(token, `name = '${FOLDER_NAME}' and 'root' in parents`)).map(
    (folder) => folder.id,
  );
}

/**
 * Every DropRevive folder in My Drive root, oldest first. Two devices that connected
 * before seeing each other's folder each created one; the oldest is where new drops
 * go, and sync reads all of them so nothing written to a duplicate is lost.
 */
let foldersInFlight: Promise<string[]> | null = null;

/** Shared by concurrent callers: connecting fires two syncs at once, and each used to create its own folder. */
export function googleFolders(token: string): Promise<string[]> {
  foldersInFlight ??= resolveFolders(token).finally(() => (foldersInFlight = null));
  return foldersInFlight;
}

async function resolveFolders(token: string): Promise<string[]> {
  const ids = await listFolderIds(token);
  const cached = folderMap().google;
  if (ids.length) {
    if (cached !== ids[0]) rememberFolder(ids[0]!);
    return ids;
  }
  // A folder created moments ago may not show up in search yet; don't create a second one.
  if (cached) {
    const probe = await apiFetch(`${DRIVE}/files/${cached}?fields=id,trashed`, token);
    if (probe.status === 200 && !parseJson<{ trashed?: boolean }>(probe.text)?.trashed)
      return [cached];
    forgetGoogleFolder();
  }
  const created = await apiFetch(`${DRIVE}/files`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: FOLDER_MIME,
      description: t("err.driveFolder"),
    }),
  });
  assertOk("google", created.status, created.text);
  const id = parseJson<DriveFile>(created.text)?.id;
  if (!id) throw new CloudError(t("err.googleNoFolder"));
  // Another device may have created one at the same moment: the oldest still wins.
  const again = await listFolderIds(token);
  const all = again.includes(id) ? again : [...again, id];
  rememberFolder(all[0]!);
  return all;
}

export async function ensureGoogleFolder(token: string): Promise<string> {
  return (await googleFolders(token))[0]!;
}

/** Every DropRevive root folder and the shelf subfolders the app created in them (oldest first). */
export async function googleLayout(
  token: string,
): Promise<{ roots: string[]; shelves: { id: string; name: string }[] }> {
  const roots = await googleFolders(token);
  return { roots, shelves: await listFolders(token, inAny(roots)) };
}

const shelfInFlight = new Map<string, Promise<string>>();

/**
 * Folder id for a shelf (no shelf = the canonical DropRevive folder). Same guard as the
 * root: one lookup per name at a time, re-query after creating, the oldest wins.
 */
export function googleShelfFolder(token: string, shelf?: string): Promise<string> {
  if (!shelf) return ensureGoogleFolder(token);
  let pending = shelfInFlight.get(shelf);
  if (!pending) {
    pending = resolveShelf(token, shelf).finally(() => shelfInFlight.delete(shelf));
    shelfInFlight.set(shelf, pending);
  }
  return pending;
}

async function resolveShelf(token: string, shelf: string): Promise<string> {
  const find = async () =>
    (await googleLayout(token)).shelves.find((folder) => folder.name === shelf)?.id;
  const existing = await find();
  if (existing) return existing;
  const { status, text } = await apiFetch(`${DRIVE}/files`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: shelf,
      mimeType: FOLDER_MIME,
      parents: [await ensureGoogleFolder(token)],
    }),
  });
  assertOk("google", status, text);
  const id = parseJson<DriveFile>(text)?.id;
  if (!id) throw new CloudError(t("err.googleNoFolder"));
  return (await find()) ?? id;
}

export async function moveGoogleFile(
  token: string,
  fileId: string,
  folderId: string,
): Promise<void> {
  const current = await apiFetch(`${DRIVE}/files/${fileId}?fields=parents`, token);
  assertOk("google", current.status, current.text);
  const parents = parseJson<{ parents?: string[] }>(current.text)?.parents ?? [];
  const remove = parents.filter((id) => id !== folderId);
  if (parents.includes(folderId) && !remove.length) return;
  const params = new URLSearchParams({
    addParents: folderId,
    removeParents: remove.join(","),
    fields: "id",
  });
  const { status, text } = await apiFetch(`${DRIVE}/files/${fileId}?${params.toString()}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assertOk("google", status, text);
}

async function folderHasChildren(token: string, folderId: string): Promise<boolean> {
  const q = `'${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({ q, pageSize: "1", fields: "files(id)" });
  const { status, text } = await apiFetch(`${DRIVE}/files?${params.toString()}`, token);
  assertOk("google", status, text);
  return (parseJson<DriveList>(text)?.files?.length ?? 0) > 0;
}

/**
 * Trash a shelf folder only when this app can see nothing left in it. drive.file
 * cannot see files the user dropped in via the Drive UI, so a non-empty folder stays.
 * Returns false when a copy of the folder is still there.
 */
export async function removeGoogleShelf(token: string, shelf: string): Promise<boolean> {
  let removedAll = true;
  for (const folder of (await googleLayout(token)).shelves.filter((item) => item.name === shelf)) {
    if (await folderHasChildren(token, folder.id)) {
      removedAll = false;
      continue;
    }
    const { status, text } = await apiFetch(`${DRIVE}/files/${folder.id}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (status === 404) continue;
    assertOk("google", status, text);
  }
  return removedAll;
}

/** Metas in every DropRevive root and shelf folder; `shelf` says which subfolder a meta sits in. */
export async function listGoogleMetas(
  token: string,
  layout: { roots: string[]; shelves: { id: string; name: string }[] },
): Promise<{ metas: RemoteMeta[]; complete: boolean }> {
  const shelfOf = new Map(layout.shelves.map((folder) => [folder.id, folder.name]));
  const metas: RemoteMeta[] = [];
  let pageToken = "";
  let complete = true;
  for (let page = 0; page < 8; page += 1) {
    const params = new URLSearchParams({
      q: `${inAny([...layout.roots, ...shelfOf.keys()])} and trashed = false and name contains '.json'`,
      pageSize: "200",
      fields: "nextPageToken,files(id,name,modifiedTime,parents)",
      orderBy: "modifiedTime desc",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const { status, text } = await apiFetch(`${DRIVE}/files?${params.toString()}`, token);
    assertOk("google", status, text);
    const json = parseJson<DriveList>(text);
    for (const file of json?.files ?? []) {
      if (!file.id || !file.name?.endsWith(".json") || !file.name.startsWith("d_")) continue;
      const shelf = file.parents?.map((id) => shelfOf.get(id)).find(Boolean);
      metas.push({
        id: file.id,
        name: file.name,
        modifiedTime: file.modifiedTime || "",
        ...(shelf ? { shelf } : {}),
      });
    }
    pageToken = json?.nextPageToken || "";
    if (!pageToken) break;
    if (page === 7) complete = false;
  }
  return { metas, complete };
}

export async function readGoogleText(token: string, fileId: string): Promise<string> {
  const { status, text } = await apiFetch(`${DRIVE}/files/${fileId}?alt=media`, token);
  assertOk("google", status, text);
  return text;
}

function multipartBody(
  meta: Record<string, unknown>,
  file: Blob,
  mime: string,
): { body: Blob; contentType: string } {
  const boundary = `dr_${crypto.randomUUID()}`;
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    body: new Blob([head, file, tail]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

function asGoogleFile(
  json: DriveFile | null,
  missing: "err.googleNoFile" | "err.googleLargeDone",
): UploadedObject {
  if (!json?.id) throw new CloudError(t(missing));
  return { id: json.id, ...(json.modifiedTime ? { modifiedTime: json.modifiedTime } : {}) };
}

async function googleAuthorizedPut(
  send: XhrSendFn,
  tokenRef: { current: string },
  url: string,
  headers: Record<string, string>,
  body: XMLHttpRequestBodyInit | null,
  onProgress?: (ratio: number) => void,
): Promise<XhrSendResult> {
  const put = (access: string) =>
    send({
      url,
      method: "PUT",
      headers: { Authorization: `Bearer ${access}`, ...headers },
      body,
      onProgress,
    });
  let result = await put(tokenRef.current);
  if (result.status === 401) {
    tokenRef.current = await renewToken("google", tokenRef.current);
    result = await put(tokenRef.current);
  }
  return result;
}

/** Query a resumable session for the next byte Drive has already received. */
async function queryGoogleReceived(
  send: XhrSendFn,
  tokenRef: { current: string },
  sessionUrl: string,
  total: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ file: UploadedObject } | { next: number }> {
  const result = await retryUploadRequest(
    () =>
      googleAuthorizedPut(
        send,
        tokenRef,
        sessionUrl,
        { "Content-Range": `bytes */${total}`, "Content-Length": "0" },
        null,
      ),
    { sleep },
  );
  if (result.status === 200 || result.status === 201) {
    return { file: asGoogleFile(parseJson<DriveFile>(result.text), "err.googleLargeDone") };
  }
  if (result.status === 308) {
    return { next: nextByteFromGoogleRange(result.header("Range")) };
  }
  assertOk("google", result.status, result.text);
  return { next: 0 };
}

export async function uploadGoogleFile(input: {
  token: string;
  folderId: string;
  name: string;
  mime: string;
  body: Blob;
  onProgress?: (ratio: number) => void;
  io?: DriveUploadIo;
}): Promise<UploadedObject> {
  const send = input.io?.xhrSend ?? xhrSend;
  const fetchImpl = input.io?.fetch ?? fetch;
  const sleep = input.io?.sleep ?? wait;
  const report = monotonicProgress(input.onProgress);
  let token = input.token;
  const meta = { name: input.name, parents: [input.folderId], mimeType: input.mime };
  if (input.body.size <= FIVE_MB) {
    const sendMultipart = (access: string) => {
      const packed = multipartBody(meta, input.body, input.mime);
      return send({
        url: `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`,
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": packed.contentType },
        body: packed.body,
        onProgress: report,
      });
    };
    const result = await retryUploadRequest(
      async () => {
        let out = await sendMultipart(token);
        if (out.status === 401) {
          token = await renewToken("google", token);
          out = await sendMultipart(token);
        }
        return out;
      },
      { sleep },
    );
    assertOk("google", result.status, result.text);
    return asGoogleFile(parseJson<DriveFile>(result.text), "err.googleNoFile");
  }

  const openSession = (access: string) =>
    fetchImpl(`${UPLOAD}?uploadType=resumable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mime,
        "X-Upload-Content-Length": String(input.body.size),
      },
      body: JSON.stringify(meta),
    });
  let session: Response;
  try {
    session = await openSession(token);
    if (session.status === 401) {
      token = await renewToken("google", token);
      session = await openSession(token);
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(t("err.googleLargeStart"));
  }
  const sessionUrl = session.headers.get("Location");
  if (!session.ok) {
    const text = await session.text();
    assertOk("google", session.status, text);
  }
  if (!sessionUrl) {
    throw new CloudError(t("err.googleLargeUrl"));
  }

  const total = input.body.size;
  const tokenRef = { current: token };
  let start = 0;

  const recover = async (fallback: unknown) => {
    try {
      return await queryGoogleReceived(send, tokenRef, sessionUrl, total, sleep);
    } catch (queryError) {
      if (fallback instanceof CloudError) throw fallback;
      throw queryError instanceof CloudError ? queryError : new CloudError(t("err.uploadCut"));
    }
  };

  while (start < total) {
    let lastError: unknown;
    let advanced = false;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt - 1));
        const recovered = await recover(lastError ?? new CloudError(t("err.uploadCut")));
        if ("file" in recovered) {
          report(1);
          return recovered.file;
        }
        if (recovered.next > start) {
          start = recovered.next;
          report(start / total);
          advanced = true;
          break;
        }
      }
      if (start >= total) break;
      const end = Math.min(start + GOOGLE_CHUNK_BYTES, total);
      const chunk = input.body.slice(start, end);
      try {
        const result = await googleAuthorizedPut(
          send,
          tokenRef,
          sessionUrl,
          {
            "Content-Type": input.mime,
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          },
          chunk,
          (ratio) => report((start + ratio * (end - start)) / total),
        );
        if (result.status === 200 || result.status === 201) {
          report(1);
          return asGoogleFile(parseJson<DriveFile>(result.text), "err.googleLargeDone");
        }
        if (result.status === 308) {
          const next = nextByteFromGoogleRange(result.header("Range"));
          if (next > start) {
            start = next;
            report(start / total);
            advanced = true;
            break;
          }
          lastError = new CloudError(t("err.uploadCut"));
          if (attempt < UPLOAD_ATTEMPTS - 1) continue;
          throw lastError;
        }
        if (isRetryableUploadStatus(result.status) && attempt < UPLOAD_ATTEMPTS - 1) {
          lastError = new CloudError(t("err.uploadCut"));
          continue;
        }
        assertOk("google", result.status, result.text);
      } catch (error) {
        lastError = error;
        if (error instanceof CloudError && !isRetryableUploadFailure(error)) throw error;
        if (isRetryableUploadFailure(error) && attempt < UPLOAD_ATTEMPTS - 1) continue;
        // Last attempt: one more status query before giving up, in case the last PUT landed.
        break;
      }
    }
    if (advanced) continue;
    const recovered = await recover(lastError ?? new CloudError(t("err.uploadCut")));
    if ("file" in recovered) {
      report(1);
      return recovered.file;
    }
    if (recovered.next > start) {
      start = recovered.next;
      report(start / total);
      continue;
    }
    throw lastError instanceof CloudError ? lastError : new CloudError(t("err.uploadCut"));
  }
  throw new CloudError(t("err.googleLargeDone"));
}

export function googleMediaUrl(fileId: string): string {
  return `${DRIVE}/files/${fileId}?alt=media`;
}

/** Fetch alt=media and leave the body as a stream. Renews the token once on 401. */
export async function openGoogleMedia(token: string, fileId: string): Promise<Response> {
  const load = (access: string) =>
    fetch(googleMediaUrl(fileId), { headers: { Authorization: `Bearer ${access}` } });
  let response = await load(token);
  if (response.status === 401) {
    const next = await renewToken("google", token);
    response = await load(next);
  }
  if (!response.ok) {
    const text = await response.text();
    assertOk("google", response.status, text);
  }
  return response;
}

export async function downloadGoogleBlob(token: string, fileId: string): Promise<Blob> {
  try {
    const response = await openGoogleMedia(token, fileId);
    return await response.blob();
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(t("err.googleDownload"));
  }
}

/** Moves the file to the Drive trash (recoverable) instead of deleting it for good. */
export async function trashGoogleFile(token: string, fileId: string): Promise<void> {
  const { status, text } = await apiFetch(`${DRIVE}/files/${fileId}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  if (status === 404) return;
  assertOk("google", status, text);
}
