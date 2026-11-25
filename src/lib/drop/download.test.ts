import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import type { DownloadHost, DownloadView, DriveDownloadIo, TokenFor } from "./download.ts";
import type { DropRecord } from "./types.ts";

register("./store.test-hooks.mjs", import.meta.url);
const { CloudError } = await import("./errors.ts");
const {
  BLOB_FILE_MAX_BYTES,
  CACHE_BLOB_MAX_BYTES,
  DRIVE_DOWNLOAD_SW_PATH,
  DRIVE_DOWNLOAD_SW_TYPE,
  contentDispositionAttachment,
  isAllowedGoogleMediaUrl,
  isDriveDownloadId,
  isSafariLike,
  isTooLargeToPreview,
  isUserCancel,
  pickDownloadMethod,
  defaultHost,
  describeDownload,
  runDownload,
  saveCloudFile,
  shouldCacheBlob,
} = await import("./download.ts");
const { downloadGoogleBlob } = await import("./google.ts");
const { en } = await import("../i18n/packs/en.ts");
const { zhMessages } = await import("../i18n/packs/zh.ts");
const { parseMicrosoftDownloadUrl } = await import("./microsoft.ts");

const THIRTY_TWO = 32 * 1024 * 1024;
const LARGE = THIRTY_TWO + 1;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.73 Mobile Safari/537.36";

function fileItem(input: {
  provider: "google" | "microsoft";
  size: number;
  fileName?: string;
  mimeType?: string;
  blobId?: string;
}): DropRecord {
  return {
    id: "item-1",
    kind: "file",
    createdAt: "2026-11-12T00:00:00.000Z",
    deviceId: "dev",
    deviceName: "Dev",
    fileName: input.fileName ?? "photo.bin",
    mimeType: input.mimeType ?? "application/octet-stream",
    size: input.size,
    refs: [
      {
        provider: input.provider,
        metaId: "meta-1",
        blobId: input.blobId ?? "blob-1",
        metaName: "photo.bin.json",
      },
    ],
    revs: {},
  };
}

function textItem(): DropRecord {
  return { ...fileItem({ provider: "google", size: 12 }), kind: "text", text: "hello", fileName: undefined };
}

function hostStub(overrides: Partial<DownloadHost> = {}): DownloadHost & { links: { url: string; fileName: string; newTab?: boolean }[] } {
  const links: { url: string; fileName: string; newTab?: boolean }[] = [];
  const host: DownloadHost & { links: typeof links } = {
    userAgent: CHROME_UA,
    origin: "https://drop.example",
    clickLink: (url, fileName, opts) => {
      links.push({ url, fileName, newTab: opts?.newTab });
    },
    links,
    randomId: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
  return host;
}

function ioStub(overrides: Partial<DriveDownloadIo> = {}): DriveDownloadIo & {
  blobs: number;
  media: number;
  msUrls: number;
} {
  const state = { blobs: 0, media: 0, msUrls: 0 };
  return {
    microsoftDownloadUrl: async () => {
      state.msUrls += 1;
      return "https://cdn.example/onedrive/file?sig=abc";
    },
    openMicrosoftContent: async (url) => {
      if (!url.startsWith("https:")) throw new Error("refusing a non-https OneDrive URL");
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Length": "4" },
      });
    },
    openGoogleMedia: async () => {
      state.media += 1;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
    fetchBlob: async () => {
      state.blobs += 1;
      return new Blob([new Uint8Array([9, 9])], { type: "application/octet-stream" });
    },
    ...overrides,
    get blobs() {
      return state.blobs;
    },
    get media() {
      return state.media;
    },
    get msUrls() {
      return state.msUrls;
    },
  };
}

const tokenFor: TokenFor = (provider) => (provider === "google" ? "ya29.google-token-secret" : "ms-token-secret");

describe("limits and helpers", () => {
  it("keeps the Blob / cache / preview cap at 32 MiB", () => {
    assert.equal(CACHE_BLOB_MAX_BYTES, THIRTY_TWO);
    assert.equal(BLOB_FILE_MAX_BYTES, THIRTY_TWO);
    assert.equal(shouldCacheBlob(THIRTY_TWO), true);
    assert.equal(shouldCacheBlob(LARGE), false);
    assert.equal(isTooLargeToPreview(fileItem({ provider: "google", size: THIRTY_TWO })), false);
    assert.equal(isTooLargeToPreview(fileItem({ provider: "google", size: LARGE })), true);
    assert.equal(isTooLargeToPreview(textItem()), false);
  });

  it("builds a Content-Disposition that carries a UTF-8 filename", () => {
    const header = contentDispositionAttachment('报告 "2026".pdf');
    assert.equal(
      header,
      `attachment; filename="__ _2026_.pdf"; filename*=UTF-8''${encodeURIComponent("报告 _2026_.pdf")}`,
    );
  });

  it("accepts only https Google Drive alt=media URLs", () => {
    assert.equal(
      isAllowedGoogleMediaUrl("https://www.googleapis.com/drive/v3/files/abc?alt=media"),
      true,
    );
    assert.equal(isAllowedGoogleMediaUrl("http://www.googleapis.com/drive/v3/files/abc?alt=media"), false);
    assert.equal(
      isAllowedGoogleMediaUrl("https://evil.example/drive/v3/files/abc?alt=media"),
      false,
    );
    assert.equal(isAllowedGoogleMediaUrl("https://www.googleapis.com/drive/v3/files/abc"), false);
    assert.equal(isDriveDownloadId("11111111-1111-4111-8111-111111111111"), true);
    assert.equal(isDriveDownloadId("../etc/passwd"), false);
    assert.equal(isDriveDownloadId("ya29.google-token-secret"), false);
  });

  it("treats an AbortError as a user cancel", () => {
    assert.equal(isUserCancel(new DOMException("closed", "AbortError")), true);
    assert.equal(isUserCancel(new Error("boom")), false);
  });
});

describe("isSafariLike", () => {
  it("detects Safari and every iOS browser, but not Chrome, Edge, Firefox or Android Chrome", () => {
    assert.equal(isSafariLike(SAFARI_MAC_UA), true);
    assert.equal(isSafariLike(IPHONE_SAFARI_UA), true);
    assert.equal(isSafariLike(IPHONE_CHROME_UA), true);
    assert.equal(isSafariLike(CHROME_UA), false);
    assert.equal(isSafariLike(EDGE_UA), false);
    assert.equal(isSafariLike(FIREFOX_UA), false);
    assert.equal(isSafariLike(ANDROID_CHROME_UA), false);
  });
});

describe("pickDownloadMethod", () => {
  it("saves a small OneDrive file as a Blob and a large one only through Save As", () => {
    assert.equal(
      pickDownloadMethod({
        provider: "microsoft",
        size: THIRTY_TWO,
        hasSavePicker: false,
        hasServiceWorker: false,
        isSafari: true,
        hasOpfs: false,
      }),
      "blob",
    );
    assert.equal(
      pickDownloadMethod({
        provider: "microsoft",
        size: LARGE,
        hasSavePicker: true,
        hasServiceWorker: true,
        isSafari: false,
        hasOpfs: true,
      }),
      "save-picker",
    );
    assert.equal(
      pickDownloadMethod({
        provider: "microsoft",
        size: LARGE,
        hasSavePicker: false,
        hasServiceWorker: true,
        isSafari: false,
        hasOpfs: true,
      }),
      "unsupported",
    );
  });

  it("keeps the Blob path for Google files at or under 32 MiB", () => {
    assert.equal(
      pickDownloadMethod({
        provider: "google",
        size: THIRTY_TWO,
        hasSavePicker: true,
        hasServiceWorker: true,
        isSafari: false,
        hasOpfs: true,
      }),
      "blob",
    );
  });

  it("prefers Save As, then a Service Worker stream, then OPFS, for large Google files", () => {
    const base = {
      provider: "google" as const,
      size: LARGE,
      hasSavePicker: true,
      hasServiceWorker: true,
      isSafari: false,
      hasOpfs: true,
    };
    assert.equal(pickDownloadMethod(base), "save-picker");
    assert.equal(pickDownloadMethod({ ...base, hasSavePicker: false }), "sw-stream");
    assert.equal(pickDownloadMethod({ ...base, hasSavePicker: false, isSafari: true }), "opfs-share");
    assert.equal(
      pickDownloadMethod({
        ...base,
        hasSavePicker: false,
        hasServiceWorker: true,
        isSafari: true,
        hasOpfs: false,
      }),
      "unsupported",
    );
    assert.equal(
      pickDownloadMethod({
        ...base,
        hasSavePicker: false,
        hasServiceWorker: false,
        isSafari: false,
        hasOpfs: false,
      }),
      "unsupported",
    );
  });
});

describe("parseMicrosoftDownloadUrl", () => {
  it("only returns an https URL from @microsoft.graph.downloadUrl", () => {
    assert.equal(
      parseMicrosoftDownloadUrl({ "@microsoft.graph.downloadUrl": "https://my.sharepoint.com/d/file" }),
      "https://my.sharepoint.com/d/file",
    );
    assert.equal(parseMicrosoftDownloadUrl({ "@microsoft.graph.downloadUrl": "http://insecure.example/d" }), null);
    assert.equal(parseMicrosoftDownloadUrl({ "@microsoft.graph.downloadUrl": "javascript:alert(1)" }), null);
    assert.equal(parseMicrosoftDownloadUrl({}), null);
    assert.equal(parseMicrosoftDownloadUrl(null), null);
  });
});

const STORAGE_NAME = "b_b033f1af-78ac-4936-a732-4be056c20b0f";

function microsoftBody(bytes: Uint8Array, name = STORAGE_NAME): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}

describe("saveCloudFile", () => {
  it("OneDrive at or under 32 MiB fetches the preauthenticated URL with no Authorization and saves the original name", async () => {
    const seen: string[] = [];
    const host = hostStub({
      createObjectURL: (blob) => `blob:onedrive/${blob.size}`,
      revokeObjectURL: () => undefined,
    });
    const progress: Array<[number, number | undefined]> = [];
    const io = ioStub({
      openMicrosoftContent: async (url) => {
        seen.push(url);
        return microsoftBody(new Uint8Array([7, 8, 9]));
      },
    });
    await saveCloudFile(
      fileItem({ provider: "microsoft", size: 3, fileName: "会议 记录.v1.2.final.pdf" }),
      tokenFor,
      host,
      io,
      { onProgress: (loaded, total) => progress.push([loaded, total]) },
    );
    assert.equal(io.msUrls, 1);
    assert.equal(io.blobs, 0);
    assert.equal(io.media, 0);
    assert.deepEqual(seen, ["https://cdn.example/onedrive/file?sig=abc"]);
    assert.equal(host.links.length, 1);
    assert.equal(host.links[0]?.url, "blob:onedrive/3");
    assert.equal(host.links[0]?.fileName, "会议 记录.v1.2.final.pdf");
    assert.equal(host.links[0]?.newTab, undefined);
    assert.deepEqual(progress, [[3, 3]]);
    assert.equal(host.links.some((link) => link.url.includes("cdn.example")), false);
  });

  it("OneDrive over 32 MiB asks for the original name before any download URL, then streams the body", async () => {
    const order: string[] = [];
    const written: number[] = [];
    const host = hostStub({
      showSaveFilePicker: async (opts) => {
        order.push(`picker:${opts.suggestedName}`);
        return {
          createWritable: async () =>
            new WritableStream({
              write(chunk) {
                written.push(chunk.byteLength);
              },
            }),
        };
      },
    });
    const io = ioStub({
      microsoftDownloadUrl: async () => {
        order.push("url");
        return "https://files.1drv.com/y4m/item";
      },
      openMicrosoftContent: async (url) => {
        order.push(`open:${url}`);
        const bytes = new Uint8Array([4, 5, 6, 7]);
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Length": "4",
            "Content-Disposition": `attachment; filename="${STORAGE_NAME}"`,
          },
        });
      },
    });
    await saveCloudFile(
      fileItem({ provider: "microsoft", size: LARGE, fileName: "报告 终稿.tar.gz" }),
      tokenFor,
      host,
      io,
      {
        prepareNetwork: async () => {
          order.push("renew");
        },
        onProgress: (loaded) => order.push(`bytes:${loaded}`),
      },
    );
    assert.deepEqual(order, ["picker:报告 终稿.tar.gz", "renew", "url", "open:https://files.1drv.com/y4m/item", "bytes:4"]);
    assert.equal(written.reduce((sum, n) => sum + n, 0), 4);
    assert.equal(host.links.length, 0);
  });

  it("a cancelled OneDrive Save As does not resolve the download URL", async () => {
    let urls = 0;
    const host = hostStub({
      showSaveFilePicker: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
    const io = ioStub({
      microsoftDownloadUrl: async () => {
        urls += 1;
        return "https://files.1drv.com/item";
      },
    });
    await saveCloudFile(fileItem({ provider: "microsoft", size: LARGE, fileName: "报告 终稿.tar.gz" }), tokenFor, host, io);
    assert.equal(urls, 0);
    assert.equal(host.links.length, 0);
  });

  it("an OneDrive stream failure cancels the response and does not open the storage name", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const host = hostStub({
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream({
            write() {
              throw new Error("disk full");
            },
          }),
      }),
    });
    const io = ioStub({
      openMicrosoftContent: async () =>
        new Response(stream, { status: 200, headers: { "Content-Length": "2", "Content-Disposition": `attachment; filename="${STORAGE_NAME}"` } }),
    });
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "microsoft", size: LARGE, fileName: "报告 终稿.tar.gz" }), tokenFor, host, io),
      /disk full/,
    );
    assert.equal(cancelled, true);
    assert.equal(host.links.length, 0);
  });

  it("a failed large OneDrive response is not saved under the original name", async () => {
    let cancelled = false;
    let opened = false;
    const host = hostStub({
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          opened = true;
          return new WritableStream();
        },
      }),
    });
    const io = ioStub({
      openMicrosoftContent: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"expired"}'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    });
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "microsoft", size: LARGE, fileName: "报告 终稿.tar.gz" }), tokenFor, host, io),
      (error: unknown) => {
        assert.ok(error instanceof CloudError);
        assert.equal(error.message, zhMessages["err.msFile"]);
        return true;
      },
    );
    assert.equal(opened, false);
    assert.equal(cancelled, true);
    assert.equal(host.links.length, 0);
  });

  it("a large OneDrive file without Save As explains the limit and does not fetch or fall back to the storage name", async () => {
    const host = hostStub();
    const io = ioStub();
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "microsoft", size: LARGE, fileName: "会议 记录.v1.2.final.pdf" }), tokenFor, host, io),
      (error: unknown) => {
        assert.ok(error instanceof CloudError);
        assert.equal(error.message, zhMessages["err.msLargeNoPicker"]);
        assert.match(en.messages["err.msLargeNoPicker"], /original name/);
        return true;
      },
    );
    assert.equal(io.msUrls, 0);
    assert.equal(host.links.length, 0);
  });

  it("refuses to buffer an OneDrive response larger than 32 MiB", async () => {
    const host = hostStub({
      createObjectURL: () => {
        throw new Error("must not build a blob URL");
      },
    });
    const io = ioStub({
      openMicrosoftContent: async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "Content-Length": String(LARGE), "Content-Disposition": `attachment; filename="${STORAGE_NAME}"` },
        }),
    });
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "microsoft", size: 4, fileName: "会议 记录.v1.2.final.pdf" }), tokenFor, host, io),
      CloudError,
    );
    assert.equal(host.links.length, 0);
  });

  it("fetches a preauthenticated OneDrive URL with no request headers", async () => {
    const { openMicrosoftContent } = await import("./download.ts");
    const original = globalThis.fetch;
    const calls: Array<{ argc: number; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push({ argc: args.length, init: args[1] });
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    try {
      await openMicrosoftContent("https://files.1drv.com/y4m");
      assert.deepEqual(calls, [{ argc: 1, init: undefined }]);
      await assert.rejects(() => openMicrosoftContent("http://files.1drv.com/y4m"), CloudError);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a non-https OneDrive URL", async () => {
    const host = hostStub();
    const io = ioStub({ microsoftDownloadUrl: async () => "http://cdn.example/file" });
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "microsoft", size: 10 }), tokenFor, host, io),
      CloudError,
    );
    assert.equal(host.links.length, 0);
  });

  it("Google small files still use the Blob path and do not open a media stream", async () => {
    const created: string[] = [];
    const host = hostStub({
      createObjectURL: (blob) => {
        created.push(`blob:${blob.size}`);
        return "blob:https://drop.example/1";
      },
      revokeObjectURL: () => undefined,
    });
    const io = ioStub();
    await saveCloudFile(fileItem({ provider: "google", size: 1024, fileName: "note.txt" }), tokenFor, host, io);
    assert.equal(io.blobs, 1);
    assert.equal(io.media, 0);
    assert.deepEqual(created, ["blob:2"]);
    assert.equal(host.links[0]?.url, "blob:https://drop.example/1");
    assert.equal(host.links[0]?.fileName, "note.txt");
  });

  it("Google large files with a Save As picker stream the body and never call blob()", async () => {
    const chunks: number[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.length);
      },
    });
    let suggested = "";
    const host = hostStub({
      showSaveFilePicker: async ({ suggestedName }) => {
        suggested = suggestedName;
        return { createWritable: async () => writable };
      },
    });
    let blobbed = 0;
    const io = ioStub({
      openGoogleMedia: async () => {
        blobbed = 0;
        const response = new Response(new Uint8Array(8).fill(7), { status: 200 });
        const original = response.blob.bind(response);
        response.blob = async () => {
          blobbed += 1;
          return original();
        };
        return response;
      },
    });
    await saveCloudFile(fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }), tokenFor, host, io);
    assert.equal(suggested, "clip.mp4");
    assert.deepEqual(chunks, [8]);
    assert.equal(blobbed, 0);
    assert.equal(io.blobs, 0);
    assert.equal(host.links.length, 0);
  });

  it("cancelling the Save As picker is not an error and does not fall through", async () => {
    const host = hostStub({
      showSaveFilePicker: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
      postToWorker: async () => {
        throw new Error("SW should not run after a cancel");
      },
    });
    const io = ioStub();
    await saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io);
    assert.equal(host.links.length, 0);
  });

  it("Google large files without a picker use the Service Worker; the URL has no token", async () => {
    const messages: unknown[] = [];
    const transfers: Transferable[][] = [];
    const body = new Uint8Array([4, 5, 6]);
    const host = hostStub({
      postToWorker: async (message, transfer) => {
        messages.push(message);
        transfers.push(transfer);
        return true;
      },
    });
    const io = ioStub({
      openGoogleMedia: async () => new Response(body, { status: 200 }),
    });
    const token = "ya29.google-token-secret";
    await saveCloudFile(fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }), tokenFor, host, io);
    assert.equal(host.links.length, 1);
    const url = host.links[0]?.url ?? "";
    assert.equal(url, `https://drop.example${DRIVE_DOWNLOAD_SW_PATH}11111111-1111-4111-8111-111111111111`);
    assert.ok(!url.includes(token));
    assert.ok(!url.includes("ya29"));
    assert.ok(!url.includes("access"));
    assert.ok(!url.includes("Bearer"));
    assert.equal(io.blobs, 0);
    const payload = messages[0] as { type: string; id: string; accessToken?: string; stream?: ReadableStream; fileName: string };
    assert.equal(payload.type, DRIVE_DOWNLOAD_SW_TYPE);
    assert.equal(payload.id, "11111111-1111-4111-8111-111111111111");
    assert.equal(payload.fileName, "clip.mp4");
    assert.equal(payload.accessToken, undefined);
    assert.ok(payload.stream);
    assert.equal(transfers[0]?.[0], payload.stream);
  });

  it("Service Worker token fallback keeps the access token out of the URL", async () => {
    const messages: Record<string, unknown>[] = [];
    const host = hostStub({
      postToWorker: async (message) => {
        const payload = message as Record<string, unknown>;
        messages.push(payload);
        // First call (stream transfer) fails; second (token) succeeds.
        return payload.accessToken === "ya29.google-token-secret";
      },
    });
    const io = ioStub({
      openGoogleMedia: async () => new Response(new Uint8Array([1]), { status: 200 }),
    });
    await saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.accessToken, undefined);
    assert.equal(messages[1]?.accessToken, "ya29.google-token-secret");
    assert.ok(isAllowedGoogleMediaUrl(String(messages[1]?.fileUrl)));
    const url = host.links[0]?.url ?? "";
    assert.equal(url.startsWith(`https://drop.example${DRIVE_DOWNLOAD_SW_PATH}`), true);
    assert.ok(!url.includes("ya29.google-token-secret"));
    assert.ok(!String(messages[1]?.fileUrl).includes("ya29"));
  });

  it("Google large files on Safari do not use the Service Worker path", async () => {
    let sw = 0;
    const host = hostStub({
      userAgent: SAFARI_MAC_UA,
      postToWorker: async () => {
        sw += 1;
        return true;
      },
    });
    const io = ioStub();
    await assert.rejects(
      () => saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io),
      (error: unknown) => error instanceof CloudError && /Chrome|Edge|OneDrive/i.test(error.message),
    );
    assert.equal(sw, 0);
    assert.equal(host.links.length, 0);
    assert.equal(io.blobs, 0);
  });

  it("Google large files on Safari can stream to OPFS and then share", async () => {
    const written: number[] = [];
    const file = new File([new Uint8Array([9, 8, 7])], "clip.mp4");
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk.byteLength);
      },
    });
    let shared: File[] = [];
    const host = hostStub({
      userAgent: IPHONE_SAFARI_UA,
      postToWorker: async () => {
        throw new Error("SW must not run on iOS");
      },
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => writable,
          getFile: async () => file,
        }),
      }),
      canShare: () => true,
      share: async (data) => {
        shared = data.files;
      },
    });
    const io = ioStub({
      openGoogleMedia: async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    });
    await saveCloudFile(fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }), tokenFor, host, io);
    assert.deepEqual(written, [3]);
    assert.equal(shared[0]?.name, "clip.mp4");
    assert.equal(host.links.length, 0);
    assert.equal(io.blobs, 0);
  });

  it("does not fall back to a whole-file Blob for a large Google file", async () => {
    const host = hostStub({ userAgent: SAFARI_MAC_UA });
    const io = ioStub();
    await assert.rejects(() => saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io));
    assert.equal(io.blobs, 0);
  });
});

describe("public/sw.js drive download", () => {
  const swPath = fileURLToPath(new URL("../../../public/sw.js", import.meta.url));
  const source = readFileSync(swPath, "utf8");

  it("intercepts the same-origin path, talks over postMessage, and never puts a token in a URL", () => {
    assert.ok(source.includes(DRIVE_DOWNLOAD_SW_TYPE));
    assert.ok(source.includes(DRIVE_DOWNLOAD_SW_PATH));
    assert.ok(source.includes("Content-Disposition"));
    assert.ok(source.includes('Cache-Control: "no-store"') || source.includes("Cache-Control: 'no-store'") || source.includes('Cache-Control": "no-store"') || source.includes("no-store"));
    assert.ok(source.includes("Authorization"));
    assert.ok(source.includes("www.googleapis.com"));
    assert.doesNotMatch(source, /__drive-download\/\$\{.*token/);
    assert.doesNotMatch(source, /__drive-download\/.*accessToken/);
    // The GET handler for the download path must run before the shell cache.
    const downloadIdx = source.indexOf(DRIVE_DOWNLOAD_SW_PATH);
    const cacheIdx = source.indexOf("caches.open(CACHE)");
    assert.ok(downloadIdx > 0 && cacheIdx > downloadIdx);
  });

  it("serves one transferred body and answers a second GET with 404", async () => {
    const listeners: Record<string, ((event: { data?: unknown; ports?: { postMessage: (msg: unknown) => void }[]; request?: { url: string; method: string }; respondWith?: (value: Promise<Response> | Response) => void }) => void)[]> = {};
    const sandbox = {
      self: {
        addEventListener(type: string, fn: (event: never) => void) {
          (listeners[type] ||= []).push(fn as never);
        },
        skipWaiting() {},
        clients: { claim: async () => undefined, matchAll: async () => [] },
        location: { origin: "https://drop.example" },
        caches: { keys: async () => [], delete: async () => undefined, open: async () => ({}) },
      },
      URL,
      Response,
      Headers,
      Date,
      fetch: async () => {
        throw new Error("token fetch must not run for a transferred stream");
      },
      console,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(source, sandbox, { filename: "public/sw.js" });
    const id = "11111111-1111-4111-8111-111111111111";
    const bytes = new Uint8Array(64).fill(7);
    let reply: { ok?: boolean } | undefined;
    listeners.message?.[0]?.({
      data: {
        type: DRIVE_DOWNLOAD_SW_TYPE,
        id,
        fileName: "clip.bin",
        mime: "application/octet-stream",
        size: bytes.byteLength,
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      },
      ports: [{ postMessage(msg: unknown) { reply = msg as { ok?: boolean }; } }],
    });
    assert.equal(JSON.stringify(reply), JSON.stringify({ ok: true }));
    const fetchOnce = async () => {
      let pending: Promise<Response> | Response | undefined;
      listeners.fetch?.[0]?.({
        request: { url: `https://drop.example${DRIVE_DOWNLOAD_SW_PATH}${id}`, method: "GET" },
        respondWith(value) {
          pending = value;
        },
      });
      return pending as Response;
    };
    const first = await fetchOnce();
    assert.equal(first.status, 200);
    assert.equal((await first.arrayBuffer()).byteLength, 64);
    const second = await fetchOnce();
    assert.equal(second.status, 404);
  });
});

function installAnchorDocument(): { anchors: { href: string; download: string; rel: string; target: string }[] } {
  const anchors: { href: string; download: string; rel: string; target: string }[] = [];
  const documentMock = {
    createElement() {
      const anchor = {
        href: "",
        download: "",
        rel: "",
        target: "",
        style: {} as { display?: string },
        click() {},
        remove() {},
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild() {} },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  return { anchors };
}

describe("Google download fixes", () => {
  it("copies the handoff sentence in both languages and never as a percent", () => {
    assert.equal(zhMessages["download.handedOff"], "已交给浏览器，请在下载列表查看");
    assert.equal(en.messages["download.handedOff"], "Handed to the browser. Check the download list.");
    assert.equal(zhMessages["download.progress"], "已下载 {loaded} / {total}");
    assert.equal(en.messages["download.progress"], "Downloaded {loaded} / {total}");
    assert.doesNotMatch(zhMessages["download.handedOff"], /%/);
    assert.doesNotMatch(en.messages["download.handedOff"], /%/);
    const handed = describeDownload({ itemId: "item-1", phase: "handed-off", loaded: 0, total: LARGE, error: null });
    assert.equal(handed, "已交给浏览器，请在下载列表查看");
    assert.doesNotMatch(handed, /%/);
    const partial = describeDownload({ itemId: "item-1", phase: "progress", loaded: 2048, total: 4096, error: null });
    assert.match(partial, /2 KB/);
    assert.match(partial, /4 KB/);
    const unknown = describeDownload({ itemId: "item-1", phase: "progress", loaded: 3, total: null, error: null });
    assert.match(unknown, /3 B/);
    assert.doesNotMatch(unknown, /\//);
  });

  it("opens the save picker before any Google request, and a cancel opens nothing", async () => {
    const order: string[] = [];
    const host = hostStub({
      showSaveFilePicker: async () => {
        order.push("picker");
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
    const io = ioStub({
      openGoogleMedia: async () => {
        order.push("open");
        return new Response(new Uint8Array([1]));
      },
    });
    await saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io);
    assert.deepEqual(order, ["picker"]);
    assert.equal(io.media, 0);
    assert.equal(host.links.length, 0);
  });

  it("reports pipe bytes and cancels the response when the writable fails", async () => {
    const progress: Array<[number, number | undefined]> = [];
    let cancelled = false;
    let opened = 0;
    const host = hostStub({
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream({
            write() {
              throw new Error("disk full");
            },
          }),
      }),
    });
    const io = ioStub({
      openGoogleMedia: async () => {
        opened += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Length": "4" } },
        );
      },
    });
    await assert.rejects(() =>
      saveCloudFile(fileItem({ provider: "google", size: LARGE }), tokenFor, host, io, {
        onProgress: (loaded, total) => progress.push([loaded, total]),
      }),
    );
    assert.equal(cancelled, true);
    assert.equal(opened, 1);
    assert.deepEqual(progress[0], [2, 4]);
  });

  it("uses the token from tokenFor after the media response, not the token captured at the start", async () => {
    let current = "ya29.old";
    const messages: Record<string, unknown>[] = [];
    const host = hostStub({
      postToWorker: async (message) => {
        const payload = message as Record<string, unknown>;
        messages.push(payload);
        return payload.accessToken === "ya29.new";
      },
    });
    const io = ioStub({
      openGoogleMedia: async () => {
        current = "ya29.new";
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    await saveCloudFile(fileItem({ provider: "google", size: LARGE }), () => current, host, io);
    assert.equal(messages.at(-1)?.accessToken, "ya29.new");
    assert.ok(!String(host.links[0]?.url).includes("ya29"));
  });

  it("the real click helper does not set a.download for the Service Worker URL", async () => {
    const { anchors } = installAnchorDocument();
    try {
      const real = defaultHost();
      const host = hostStub({
        clickLink: real.clickLink,
        postToWorker: async () => true,
      });
      const io = ioStub({
        openGoogleMedia: async () => new Response(new Uint8Array([9, 9, 9, 9]), { status: 200 }),
      });
      await saveCloudFile(fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }), tokenFor, host, io);
      assert.equal(anchors.length, 1);
      assert.equal(anchors[0]?.download, "");
      assert.match(anchors[0]?.href ?? "", /\/__drive-download\/11111111-1111-4111-8111-111111111111$/);
      assert.equal(anchors[0]?.rel, "noopener");
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("still sets a.download for a Blob save and for OneDrive", async () => {
    const { anchors } = installAnchorDocument();
    try {
      const real = defaultHost();
      const blobHost = hostStub({
        clickLink: real.clickLink,
        createObjectURL: () => "blob:https://drop.example/1",
        revokeObjectURL: () => undefined,
      });
      await saveCloudFile(fileItem({ provider: "google", size: 1024, fileName: "note.txt" }), tokenFor, blobHost, ioStub());
      assert.equal(anchors[0]?.download, "note.txt");

      const driveHost = hostStub({
        clickLink: real.clickLink,
        createObjectURL: () => "blob:https://drop.example/onedrive",
        revokeObjectURL: () => undefined,
      });
      await saveCloudFile(
        fileItem({ provider: "microsoft", size: 4, fileName: "报告 终稿.tar.gz" }),
        tokenFor,
        driveHost,
        ioStub({
          openMicrosoftContent: async () => microsoftBody(new Uint8Array([1, 2, 3, 4])),
        }),
      );
      assert.equal(anchors[1]?.download, "报告 终稿.tar.gz");
      assert.equal(anchors[1]?.href, "blob:https://drop.example/onedrive");
      assert.equal(anchors[1]?.target, "");
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("returns no worker when this page has no controller", async () => {
    let activePosts = 0;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: CHROME_UA,
        serviceWorker: {
          controller: null,
          ready: Promise.resolve({
            active: {
              postMessage() {
                activePosts += 1;
              },
            },
          }),
        },
      },
    });
    try {
      const worker = await defaultHost().serviceWorker?.();
      assert.equal(worker, null);
      assert.equal(activePosts, 0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
    }
  });

  it("counts Google blob bytes while they arrive", async () => {
    const original = globalThis.fetch;
    const seen: Array<[number, number | undefined]> = [];
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Length": "4" },
      });
    try {
      const blob = await downloadGoogleBlob("ya29.test", "file-1", (loaded, total) => seen.push([loaded, total]));
      assert.equal(blob.size, 4);
      assert.deepEqual(seen, [[4, 4]]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("runDownload", () => {
  function harness(overrides: { item?: ReturnType<typeof fileItem>; renew?: (provider: "google" | "microsoft") => Promise<void>; host?: DownloadHost; io?: DriveDownloadIo; tokenFor?: TokenFor } = {}) {
    const views: Array<DownloadView | null> = [];
    let view: DownloadView | null = null;
    const item = overrides.item ?? fileItem({ provider: "google", size: 4096, fileName: "note.txt" });
    const run = () =>
      runDownload({
        item,
        getView: () => view,
        setView: (next) => {
          view = next;
          views.push(next ? { ...next } : null);
        },
        tokenFor: overrides.tokenFor ?? (() => "ya29.renewed"),
        renew: overrides.renew ?? (async () => undefined),
        host: overrides.host ?? hostStub({
          createObjectURL: () => "blob:https://drop.example/1",
          revokeObjectURL: () => undefined,
        }),
        io: overrides.io ?? ioStub({
          fetchBlob: async (_item, onProgress) => {
            onProgress?.(1024, 4096);
            onProgress?.(4096, 4096);
            return new Blob([new Uint8Array(4096)]);
          },
        }),
      });
    return { views, run, get view() { return view; } };
  }

  it("records OneDrive bytes under the original name, and a large file without Save As stays an error", async () => {
    const small = harness({
      item: fileItem({ provider: "microsoft", size: 4, fileName: "会议 记录.v1.2.final.pdf" }),
      host: hostStub({
        createObjectURL: () => "blob:https://drop.example/od",
        revokeObjectURL: () => undefined,
      }),
      io: ioStub({
        openMicrosoftContent: async () => microsoftBody(new Uint8Array([1, 2, 3, 4])),
      }),
    });
    await small.run();
    assert.ok(small.views.some((entry) => entry?.phase === "progress" && entry.loaded === 4 && entry.total === 4));
    assert.equal(small.view, null);

    const large = harness({
      item: fileItem({ provider: "microsoft", size: LARGE, fileName: "报告 终稿.tar.gz" }),
      host: hostStub(),
      io: ioStub(),
    });
    await assert.rejects(() => large.run(), /原来的文件名/);
    assert.equal(large.view?.phase, "error");
    assert.match(large.view?.error ?? "", /原来的文件名/);
  });

  it("shows progress before renewal and ignores a second click while downloading", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = 0;
    const first = harness({
      renew: async () => {
        assert.equal(first.view?.phase, "progress");
        assert.equal(first.view?.loaded, 0);
        assert.equal(first.view?.total, 4096);
        await gate;
      },
      io: ioStub({
        fetchBlob: async () => {
          opened += 1;
          return new Blob([new Uint8Array(4)]);
        },
      }),
    });
    const pending = first.run();
    const second = harness();
    second.views.length = 0;
    // Share the in-flight view so the second call sees progress.
    const blocked = runDownload({
      item: fileItem({ provider: "google", size: 4096 }),
      getView: () => first.view,
      setView: () => {
        throw new Error("second click must not change download state");
      },
      tokenFor: () => "ya29.renewed",
      renew: async () => {
        throw new Error("second click must not renew");
      },
      host: hostStub(),
      io: ioStub({
        fetchBlob: async () => {
          opened += 1;
          return new Blob();
        },
      }),
    });
    await blocked;
    assert.equal(opened, 0);
    release?.();
    await pending;
    assert.equal(opened, 1);
    assert.ok(first.views.some((entry) => entry?.phase === "progress" && entry.loaded === 0));
    assert.equal(first.view, null);
  });

  it("records blob bytes on the download view before it finishes", async () => {
    const state = harness();
    await state.run();
    assert.ok(state.views.some((entry) => entry?.phase === "progress" && entry.loaded === 1024 && entry.total === 4096));
    assert.ok(state.views.some((entry) => entry?.phase === "progress" && entry.loaded === 4096 && entry.total === 4096));
    assert.equal(state.view, null);
  });

  it("keeps a browser handoff visible and does not mark it finished", async () => {
    const state = harness({
      item: fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }),
      host: hostStub({ postToWorker: async () => true }),
      io: ioStub({
        openGoogleMedia: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      }),
    });
    await state.run();
    assert.equal(state.view?.phase, "handed-off");
    assert.notEqual(state.view?.loaded, state.view?.total);
    assert.equal(describeDownload(state.view!), "已交给浏览器，请在下载列表查看");
  });

  it("clears state on cancel and keeps an error that can be replaced by another download", async () => {
    const cancelled = harness({
      item: fileItem({ provider: "google", size: LARGE }),
      host: hostStub({
        showSaveFilePicker: async () => {
          throw new DOMException("The user aborted a request.", "AbortError");
        },
      }),
    });
    await cancelled.run();
    assert.equal(cancelled.view, null);

    const failed = harness({
      io: ioStub({
        fetchBlob: async () => {
          throw new Error("network down");
        },
      }),
    });
    await assert.rejects(() => failed.run(), /network down/);
    assert.equal(failed.view?.phase, "error");
    assert.match(failed.view?.error ?? "", /network down/);

    // Continue from the error view, which must not block a retry.
    const viewHolder: { current: DownloadView | null } = { current: failed.view };
    await runDownload({
      item: fileItem({ provider: "google", size: 4096, fileName: "note.txt" }),
      getView: () => viewHolder.current,
      setView: (next) => {
        viewHolder.current = next;
      },
      tokenFor: () => "ya29.renewed",
      renew: async () => {
        assert.equal(viewHolder.current?.phase, "progress");
      },
      host: hostStub({
        createObjectURL: () => "blob:https://drop.example/2",
        revokeObjectURL: () => undefined,
      }),
      io: ioStub(),
    });
    assert.equal(viewHolder.current, null);
  });

  it("opens Save As before token renewal, and a cancel does not renew", async () => {
    const order: string[] = [];
    const saved = harness({
      item: fileItem({ provider: "google", size: LARGE, fileName: "clip.mp4" }),
      renew: async () => {
        order.push("renew");
      },
      host: hostStub({
        showSaveFilePicker: async () => {
          order.push("picker");
          return { createWritable: async () => new WritableStream() };
        },
      }),
      io: ioStub({
        openGoogleMedia: async () => {
          order.push("open");
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Length": "4" } });
        },
      }),
    });
    await saved.run();
    assert.deepEqual(order, ["picker", "renew", "open"]);

    const cancelledOrder: string[] = [];
    const cancelled = harness({
      item: fileItem({ provider: "google", size: LARGE }),
      renew: async () => {
        cancelledOrder.push("renew");
      },
      host: hostStub({
        showSaveFilePicker: async () => {
          cancelledOrder.push("picker");
          throw new DOMException("The user aborted a request.", "AbortError");
        },
      }),
    });
    await cancelled.run();
    assert.deepEqual(cancelledOrder, ["picker"]);
    assert.equal(cancelled.view, null);
  });

  it("renews the access token before opening Google", async () => {
    const seen: string[] = [];
    let access = "ya29.stale";
    const state = harness({
      item: fileItem({ provider: "google", size: LARGE }),
      tokenFor: () => access,
      renew: async (provider) => {
        assert.equal(provider, "google");
        access = "ya29.fresh";
      },
      host: hostStub({
        showSaveFilePicker: async () => ({
          createWritable: async () => new WritableStream(),
        }),
      }),
      io: ioStub({
        openGoogleMedia: async (token) => {
          seen.push(token);
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Length": "4" } });
        },
      }),
    });
    await state.run();
    assert.deepEqual(seen, ["ya29.fresh"]);
  });
});
