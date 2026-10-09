import { t } from "@/lib/i18n";
import { renewToken } from "./drive-token";
import { assertOk, CloudError } from "./errors";
import { apiFetch as graphFetch, parseJson, xhrSend } from "./http";
import { readJson, writeJson } from "./secrets";
import { FOLDER_NAME, FOLDERS_KEY, type RemoteMeta, type UploadedObject } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SIMPLE_LIMIT = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10;

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
async function apiFetch(url: string, token: string, init?: RequestInit): Promise<{ status: number; text: string }> {
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

async function getItem(token: string, url: string): Promise<{ status: number; item: DriveItem | null; text: string }> {
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
  const byPath = await getItem(token, `${GRAPH}/me/drive/root:/${FOLDER_NAME}?select=id,folder,name`);
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

async function listChildren(token: string, first: string): Promise<{ items: DriveItem[]; complete: boolean } | null> {
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
export async function listMicrosoftMetas(token: string): Promise<{ metas: RemoteMeta[]; shelves: string[]; complete: boolean }> {
  const select = "?$top=200&$select=id,name,lastModifiedDateTime,file,folder";
  const top = await listChildren(token, `${GRAPH}/me/drive/root:/${FOLDER_NAME}:/children${select}`);
  if (!top) return { metas: [], shelves: [], complete: true };
  const metas: RemoteMeta[] = [];
  const shelves: string[] = [];
  let complete = top.complete;
  const take = (items: DriveItem[], shelf?: string) => {
    for (const item of items) {
      if (!item.id || item.folder || !item.name?.endsWith(".json") || !item.name.startsWith("d_")) continue;
      metas.push({ id: item.id, name: item.name, modifiedTime: item.lastModifiedDateTime || "", ...(shelf ? { shelf } : {}) });
    }
  };
  take(top.items);
  for (const folder of top.items) {
    if (!folder.folder || !folder.id || !folder.name) continue;
    shelves.push(folder.name);
    const children = await listChildren(token, `${GRAPH}/me/drive/items/${folder.id}/children${select}`);
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

export async function moveMicrosoftFile(token: string, itemId: string, folderId: string): Promise<void> {
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
  const left = await listChildren(token, `${GRAPH}/me/drive/items/${found.item.id}/children?$top=1&$select=id`);
  if (left?.items.length) return false;
  await deleteMicrosoftFile(token, found.item.id);
  return true;
}

async function downloadUrl(token: string, itemId: string): Promise<string> {
  const { status, text } = await apiFetch(`${GRAPH}/me/drive/items/${itemId}?select=id,@microsoft.graph.downloadUrl`, token);
  assertOk("microsoft", status, text);
  const json = parseJson<{ "@microsoft.graph.downloadUrl"?: string }>(text);
  const url = json?.["@microsoft.graph.downloadUrl"];
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

export async function uploadMicrosoftFile(input: {
  token: string;
  name: string;
  mime: string;
  body: Blob;
  shelf?: string;
  onProgress?: (ratio: number) => void;
}): Promise<UploadedObject> {
  const path = `${GRAPH}/me/drive/root:/${shelfPath(input.shelf)}/${input.name}:/content`;
  const uploaded = (item: DriveItem): UploadedObject => ({
    id: item.id!,
    ...(item.lastModifiedDateTime ? { modifiedTime: item.lastModifiedDateTime } : {}),
  });
  if (input.body.size <= SIMPLE_LIMIT) {
    const result = await xhrSend({
      url: path,
      method: "PUT",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": input.mime },
      body: input.body,
      onProgress: input.onProgress,
    });
    assertOk("microsoft", result.status, result.text);
    const json = parseJson<DriveItem>(result.text);
    if (!json?.id) throw new CloudError(t("err.msNoFile"));
    return uploaded(json);
  }
  const sessionRes = await apiFetch(`${GRAPH}/me/drive/root:/${shelfPath(input.shelf)}/${input.name}:/createUploadSession`, input.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace", name: input.name } }),
  });
  assertOk("microsoft", sessionRes.status, sessionRes.text);
  const session = parseJson<{ uploadUrl?: string }>(sessionRes.text);
  if (!session?.uploadUrl) throw new CloudError(t("err.msNoUpload"));
  const total = input.body.size;
  let start = 0;
  let itemId = "";
  while (start < total) {
    const end = Math.min(start + CHUNK, total);
    const chunk = input.body.slice(start, end);
    let response: Response;
    try {
      response = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${start}-${end - 1}/${total}` },
        body: chunk,
      });
    } catch {
      throw new CloudError(t("err.msLargeCut"));
    }
    const text = await response.text();
    if (response.status !== 202 && (response.status < 200 || response.status >= 300)) {
      assertOk("microsoft", response.status, text);
    }
    const json = parseJson<DriveItem>(text);
    if (json?.id) itemId = json.id;
    start = end;
    input.onProgress?.(start / total);
  }
  if (!itemId) throw new CloudError(t("err.msLargeDone"));
  return { id: itemId };
}

export async function deleteMicrosoftFile(token: string, itemId: string): Promise<void> {
  const { status, text } = await apiFetch(`${GRAPH}/me/drive/items/${itemId}`, token, { method: "DELETE" });
  if (status === 404) return;
  assertOk("microsoft", status, text);
}
