import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import type { DownloadHost, DriveDownloadIo, TokenFor } from "./download.ts";
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
  saveCloudFile,
  shouldCacheBlob,
} = await import("./download.ts");
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
  it("always hands OneDrive to the browser, at any size", () => {
    assert.equal(
      pickDownloadMethod({
        provider: "microsoft",
        size: LARGE,
        hasSavePicker: true,
        hasServiceWorker: true,
        isSafari: false,
        hasOpfs: true,
      }),
      "onedrive-url",
    );
    assert.equal(
      pickDownloadMethod({
        provider: "microsoft",
        size: 10,
        hasSavePicker: false,
        hasServiceWorker: false,
        isSafari: true,
        hasOpfs: false,
      }),
      "onedrive-url",
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

describe("saveCloudFile", () => {
  it("OneDrive: hands the https downloadUrl to the browser and never calls blob or Google", async () => {
    const host = hostStub();
    const io = ioStub();
    let blobbed = false;
    const originalBlob = Response.prototype.blob;
    Response.prototype.blob = async function blob() {
      blobbed = true;
      return originalBlob.call(this);
    };
    try {
      await saveCloudFile(fileItem({ provider: "microsoft", size: LARGE, fileName: "big.iso" }), tokenFor, host, io);
    } finally {
      Response.prototype.blob = originalBlob;
    }
    assert.equal(io.msUrls, 1);
    assert.equal(io.blobs, 0);
    assert.equal(io.media, 0);
    assert.equal(blobbed, false);
    assert.equal(host.links.length, 1);
    assert.equal(host.links[0]?.url, "https://cdn.example/onedrive/file?sig=abc");
    assert.equal(host.links[0]?.fileName, "big.iso");
    assert.equal(host.links[0]?.newTab, true);
    assert.doesNotMatch(host.links[0]?.url ?? "", /ms-token-secret/);
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
});
