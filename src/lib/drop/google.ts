import { t } from "@/lib/i18n";
import { renewToken } from "./drive-token";
import { assertOk, CloudError } from "./errors";
import { apiFetch as driveFetch, parseJson, xhrSend } from "./http";
import { readJson, writeJson } from "./secrets";
import { FOLDER_NAME, FOLDERS_KEY, type RemoteMeta, type UploadedObject } from "./types";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIVE_MB = 5 * 1024 * 1024;

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
async function apiFetch(url: string, token: string, init?: RequestInit): Promise<{ status: number; text: string }> {
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
  return (parseJson<DriveList>(text)?.files ?? []).flatMap((file) => (file.id ? [{ id: file.id, name: file.name || "" }] : []));
}

async function listFolderIds(token: string): Promise<string[]> {
  return (await listFolders(token, `name = '${FOLDER_NAME}' and 'root' in parents`)).map((folder) => folder.id);
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
    if (probe.status === 200 && !parseJson<{ trashed?: boolean }>(probe.text)?.trashed) return [cached];
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
export async function googleLayout(token: string): Promise<{ roots: string[]; shelves: { id: string; name: string }[] }> {
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
  const find = async () => (await googleLayout(token)).shelves.find((folder) => folder.name === shelf)?.id;
  const existing = await find();
  if (existing) return existing;
  const { status, text } = await apiFetch(`${DRIVE}/files`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: shelf, mimeType: FOLDER_MIME, parents: [await ensureGoogleFolder(token)] }),
  });
  assertOk("google", status, text);
  const id = parseJson<DriveFile>(text)?.id;
  if (!id) throw new CloudError(t("err.googleNoFolder"));
  return (await find()) ?? id;
}

export async function moveGoogleFile(token: string, fileId: string, folderId: string): Promise<void> {
  const current = await apiFetch(`${DRIVE}/files/${fileId}?fields=parents`, token);
  assertOk("google", current.status, current.text);
  const parents = parseJson<{ parents?: string[] }>(current.text)?.parents ?? [];
  const remove = parents.filter((id) => id !== folderId);
  if (parents.includes(folderId) && !remove.length) return;
  const params = new URLSearchParams({ addParents: folderId, removeParents: remove.join(","), fields: "id" });
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
      metas.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime || "", ...(shelf ? { shelf } : {}) });
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

function multipartBody(meta: Record<string, unknown>, file: Blob, mime: string): { body: Blob; contentType: string } {
  const boundary = `dr_${crypto.randomUUID()}`;
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return { body: new Blob([head, file, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

export async function uploadGoogleFile(input: {
  token: string;
  folderId: string;
  name: string;
  mime: string;
  body: Blob;
  onProgress?: (ratio: number) => void;
}): Promise<UploadedObject> {
  let token = input.token;
  const meta = { name: input.name, parents: [input.folderId], mimeType: input.mime };
  const sendMultipart = (access: string) => {
    const packed = multipartBody(meta, input.body, input.mime);
    return xhrSend({
      url: `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`,
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": packed.contentType },
      body: packed.body,
      onProgress: input.onProgress,
    });
  };
  if (input.body.size <= FIVE_MB) {
    let result = await sendMultipart(token);
    if (result.status === 401) {
      token = await renewToken("google", token);
      result = await sendMultipart(token);
    }
    assertOk("google", result.status, result.text);
    const json = parseJson<DriveFile>(result.text);
    if (!json?.id) throw new CloudError(t("err.googleNoFile"));
    return { id: json.id, ...(json.modifiedTime ? { modifiedTime: json.modifiedTime } : {}) };
  }

  let session: Response;
  try {
    session = await fetch(`${UPLOAD}?uploadType=resumable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mime,
        "X-Upload-Content-Length": String(input.body.size),
      },
      body: JSON.stringify(meta),
    });
  } catch {
    throw new CloudError(t("err.googleLargeStart"));
  }
  if (session.status === 401) {
    token = await renewToken("google", token);
    session = await fetch(`${UPLOAD}?uploadType=resumable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mime,
        "X-Upload-Content-Length": String(input.body.size),
      },
      body: JSON.stringify(meta),
    });
  }
  const sessionUrl = session.headers.get("Location");
  if (!session.ok) {
    const text = await session.text();
    assertOk("google", session.status, text);
  }
  if (!sessionUrl) {
    throw new CloudError(t("err.googleLargeUrl"));
  }
  const uploaded = await xhrSend({
    url: sessionUrl,
    method: "PUT",
    headers: {
      "Content-Type": input.mime,
      "Content-Range": `bytes 0-${input.body.size - 1}/${input.body.size}`,
    },
    body: input.body,
    onProgress: input.onProgress,
  });
  assertOk("google", uploaded.status, uploaded.text);
  const json = parseJson<DriveFile>(uploaded.text);
  if (!json?.id) throw new CloudError(t("err.googleLargeDone"));
  return { id: json.id, ...(json.modifiedTime ? { modifiedTime: json.modifiedTime } : {}) };
}

export async function downloadGoogleBlob(token: string, fileId: string): Promise<Blob> {
  const load = (access: string) =>
    fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${access}` } });
  try {
    let response = await load(token);
    if (response.status === 401) {
      token = await renewToken("google", token);
      response = await load(token);
    }
    if (!response.ok) {
      const text = await response.text();
      assertOk("google", response.status, text);
    }
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
