import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { buildMeta } from "./meta.ts";
import type { CloudRef, DropRecord, GoogleSession, MicrosoftSession, ProviderId } from "./types.ts";

// The real store, with the browser, the Worker and both drives swapped for in-memory fakes
// (store.test-fakes.ts). Covers drive sync, delete and token expiry; store.test.ts covers
// folders, multi-select and the load-time /token check.
register("./store.test-hooks.mjs", import.meta.url);
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
const { fake } = await import("./store.test-fakes.ts");
const { useDropStore } = await import("./store.ts");
const { t } = await import("../i18n/index.ts");

const OUTBOX_KEY = "droprevive.outbox";
const HOUR = 3_600_000;

const google = (patch: Partial<GoogleSession> = {}): GoogleSession => ({
  accessToken: "g-token",
  expiresAt: Date.now() + HOUR,
  clientId: "google-client",
  via: "server",
  email: "me@gmail.com",
  ...patch,
});
const microsoft = (patch: Partial<MicrosoftSession> = {}): MicrosoftSession => ({
  accessToken: "m-token",
  expiresAt: Date.now() + HOUR,
  clientId: "microsoft-client",
  via: "server",
  username: "me@outlook.com",
  ...patch,
});

function metaText(id: string, createdAt: string, text = `note ${id}`): string {
  return JSON.stringify(buildMeta({ id, kind: "text", createdAt, deviceId: "d1", deviceName: "Laptop", text, size: text.length }));
}

function put(drive: ProviderId, fileId: string, id: string, createdAt: string, rev = "r1", text?: string): void {
  fake.drives[drive].files.set(fileId, { id: fileId, text: metaText(id, createdAt, text), modifiedTime: rev });
}

function record(id: string, createdAt: string, refs: CloudRef[], revs: DropRecord["revs"] = {}): DropRecord {
  return { id, kind: "text", createdAt, deviceId: "d1", deviceName: "Laptop", text: `note ${id}`, size: 6, refs, revs, folders: {} };
}

const ref = (provider: ProviderId, metaId: string, blobId?: string): CloudRef => ({
  provider,
  metaId,
  metaName: `d_${metaId}.json`,
  ...(blobId ? { blobId } : {}),
});

const state = () => useDropStore.getState();
const ids = () => state().items.map((item) => item.id);
const item = (id: string) => state().items.find((entry) => entry.id === id);
const calls = (op: string, drive?: ProviderId) => fake.calls.filter((call) => call.op === op && (!drive || call.drive === drive));
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const setOnline = (value: boolean) => Object.defineProperty(globalThis.navigator, "onLine", { value, configurable: true });

/** Both drives connected with fresh tokens, no folders, nothing local. */
function seed(items: DropRecord[] = []): void {
  fake.reset();
  setOnline(true);
  useDropStore.setState({
    hydrated: true,
    busy: false,
    online: true,
    google: google(),
    microsoft: microsoft(),
    items,
    selected: [],
    shelves: [],
    syncError: null,
    lastSyncAt: null,
  });
}

/** Wait for the sync a send/delete starts when it finishes. */
async function settle(): Promise<void> {
  await tick();
  await state().sync();
}

describe("store sync: listing and merging", () => {
  beforeEach(() => seed());

  it("merges new notes from both drives into one list, newest first, without writing", async () => {
    put("google", "g-old", "old", "2026-10-01T08:00:00.000Z");
    put("microsoft", "m-new", "new", "2026-10-01T10:00:00.000Z");
    put("google", "g-both", "both", "2026-10-01T09:00:00.000Z");
    put("microsoft", "m-both", "both", "2026-10-01T09:00:00.000Z");
    await state().sync();
    assert.deepEqual(ids(), ["new", "both", "old"]);
    assert.deepEqual(
      item("both")?.refs.map((entry) => `${entry.provider}:${entry.metaId}`).sort(),
      ["google:g-both", "microsoft:m-both"],
      "one record holding both copies",
    );
    assert.deepEqual(item("both")?.revs, { google: "r1", microsoft: "r1" });
    assert.deepEqual(fake.writes(), []);
    assert.equal(state().syncError, null);
    assert.equal(state().syncing, false);
    assert.ok(state().lastSyncAt);
  });

  it("an unchanged revision is not read again; a newer one is read and its content wins", async () => {
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    put("microsoft", "m-b", "b", "2026-10-01T09:00:00.000Z");
    await state().sync();
    assert.equal(calls("read").length, 2);
    fake.calls = [];
    put("microsoft", "m-b", "b", "2026-10-01T09:00:00.000Z", "r2", "edited elsewhere");
    await state().sync();
    assert.deepEqual(calls("read").map((call) => call.arg), ["m-b"]);
    assert.equal(item("b")?.text, "edited elsewhere");
    assert.equal(item("b")?.revs.microsoft, "r2");
    assert.equal(item("a")?.text, "note a");
  });

  it("a note gone from a complete listing leaves; one still on the other drive stays with that copy only", async () => {
    seed([
      record("a", "2026-10-01T10:00:00.000Z", [ref("microsoft", "m-a")], { microsoft: "r1" }),
      record("b", "2026-10-01T09:00:00.000Z", [ref("google", "g-b"), ref("microsoft", "m-b")], { google: "r1", microsoft: "r1" }),
    ]);
    put("google", "g-b", "b", "2026-10-01T09:00:00.000Z");
    await state().sync();
    assert.deepEqual(ids(), ["b"]);
    assert.deepEqual(item("b")?.refs.map((entry) => entry.provider), ["google"]);
    assert.deepEqual(fake.writes(), []);
  });

  it("an item added here while a sync ran is kept when that sync lands", async () => {
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    let release!: () => void;
    fake.hold = new Promise((resolve) => (release = resolve));
    const run = state().sync();
    await tick();
    const fresh = record("fresh", "2026-10-02T10:00:00.000Z", [ref("google", "g-fresh")]);
    useDropStore.setState({ items: [fresh, ...state().items] });
    fake.hold = null;
    release();
    await run;
    assert.deepEqual(ids(), ["fresh", "a"]);
  });

  it("sync requests during a run share it and queue exactly one more pass", async () => {
    let release!: () => void;
    fake.hold = new Promise((resolve) => (release = resolve));
    const first = state().sync();
    await tick();
    const second = state().sync();
    const third = state().sync();
    assert.equal(second, first);
    assert.equal(third, first);
    fake.hold = null;
    release();
    await first;
    assert.equal(calls("list", "microsoft").length, 2, "the first pass and one queued pass");
    // Google lists twice per pass: the folder layout, then the metas.
    assert.equal(calls("list", "google").length, 4);
  });

  it("does nothing before hydrate or while a send/delete owns the drives", async () => {
    useDropStore.setState({ hydrated: false });
    await state().sync();
    useDropStore.setState({ hydrated: true, busy: true });
    await state().sync();
    assert.deepEqual(fake.calls, []);
    assert.equal(state().syncing, false);
  });

  it("one drive failing to list: the other still syncs and the failure is reported", async () => {
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    fake.listError.google = new Error("Google Drive said no");
    await state().sync();
    assert.deepEqual(ids(), ["a"]);
    assert.equal(state().syncError, "Google Drive said no");
    assert.equal(state().syncing, false);
    fake.listError = {};
    await state().sync();
    assert.equal(state().syncError, null, "the next good sync clears it");
  });

  it("no drive connected: no request and no warning", async () => {
    useDropStore.setState({ google: null, microsoft: null });
    await state().sync();
    assert.deepEqual(fake.calls, []);
    assert.equal(state().syncError, null);
  });
});

describe("store delete", () => {
  beforeEach(() => {
    seed([
      record("a", "2026-10-01T10:00:00.000Z", [ref("google", "g-a", "g-a-blob"), ref("microsoft", "m-a")], { google: "r1", microsoft: "r1" }),
      record("b", "2026-10-01T09:00:00.000Z", [ref("microsoft", "m-b")], { microsoft: "r1" }),
    ]);
    put("google", "g-a", "a", "2026-10-01T10:00:00.000Z");
    fake.drives.google.files.set("g-a-blob", { id: "g-a-blob", text: "", modifiedTime: "r1" });
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    put("microsoft", "m-b", "b", "2026-10-01T09:00:00.000Z");
    useDropStore.setState({ selected: ["a", "b"] });
  });

  it("deletes every copy (blob and meta) in the cloud, then drops the item here and from the selection", async () => {
    assert.equal(await state().remove(["a"]), null);
    assert.deepEqual(
      fake.writes().map((call) => `${call.drive}:${call.op}:${call.arg}`),
      ["google:trash:g-a-blob", "google:trash:g-a", "microsoft:delete:m-a"],
    );
    assert.deepEqual(ids(), ["b"]);
    assert.deepEqual(state().selected, ["b"]);
    assert.equal(state().busy, false);
    await settle();
    assert.ok(calls("list").length > 0, "a sync runs after the delete");
    assert.deepEqual(ids(), ["b"]);
  });

  it("a copy the drive refuses stays: the item keeps only that copy and the call rejects", async () => {
    fake.failing.add("m-a");
    await assert.rejects(state().remove(["a"]), { message: t("err.deleteKept") });
    assert.deepEqual(item("a")?.refs.map((entry) => entry.metaId), ["m-a"]);
    assert.equal(fake.drives.google.files.has("g-a"), false);
    assert.deepEqual(state().selected, ["a", "b"], "still selected, so a retry is one tap");
    assert.equal(state().busy, false);
  });

  it("a copy on a drive that is not connected here stays", async () => {
    useDropStore.setState({ google: null });
    await assert.rejects(state().remove(["a"]), { message: t("err.deleteKept") });
    assert.deepEqual(item("a")?.refs.map((entry) => entry.provider), ["google"]);
    assert.equal(fake.drives.microsoft.files.has("m-a"), false);
  });

  it("offline: refuses before touching anything", async () => {
    setOnline(false);
    await assert.rejects(state().remove(["a"]), { message: t("err.offlineDelete") });
    setOnline(true);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(ids(), ["a", "b"]);
    assert.equal(state().busy, false);
  });

  it("unknown ids: nothing to do", async () => {
    assert.equal(await state().remove(["nope"]), null);
    assert.deepEqual(fake.calls, []);
  });

  it("the outbox is replayed on the next sync; refs that still fail stay queued", async () => {
    fake.storage.set(OUTBOX_KEY, [{ refs: [ref("microsoft", "m-b"), ref("google", "g-gone")] }, { refs: "bad" }]);
    await state().sync();
    assert.deepEqual(fake.storage.get(OUTBOX_KEY), [{ refs: [ref("google", "g-gone")] }]);
    assert.equal(fake.drives.microsoft.files.has("m-b"), false);
  });
});

describe("store token expiry", () => {
  beforeEach(() => {
    seed();
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    useDropStore.setState({ google: null });
  });

  it("a fresh token is used as is: no renewal", async () => {
    await state().sync();
    assert.equal(calls("renew").length, 0);
    assert.deepEqual(ids(), ["a"]);
  });

  it("a lapsed token is renewed once and the renewal lands in the session", async () => {
    useDropStore.setState({ microsoft: microsoft({ accessToken: "old", expiresAt: Date.now() - 60_000 }) });
    fake.renew = async (provider) => {
      fake.renewal?.(provider, { provider, accessToken: "fresh", expiresAt: Date.now() + HOUR, who: "new@outlook.com" });
      return "fresh";
    };
    await state().sync();
    assert.equal(calls("renew", "microsoft").length, 1);
    assert.equal(state().microsoft?.accessToken, "fresh");
    assert.equal(state().microsoft?.username, "new@outlook.com");
    assert.equal(state().microsoft?.via, "server");
    assert.deepEqual(ids(), ["a"]);
    assert.equal(state().syncError, null);
  });

  it("renewal fails but the token still has a little life: use it, no warning", async () => {
    useDropStore.setState({ microsoft: microsoft({ expiresAt: Date.now() + 2 * 60_000 }) });
    fake.renew = async () => {
      throw new Error("network");
    };
    await state().sync();
    assert.equal(calls("renew").length, 1);
    assert.ok(calls("list", "microsoft").length > 0);
    assert.equal(state().syncError, null);
  });

  it("renewal fails and the token has lapsed: no drive request, the error is shown, the session stays", async () => {
    useDropStore.setState({ microsoft: microsoft({ expiresAt: Date.now() - 1 }) });
    fake.renew = async () => {
      throw new Error("OneDrive renewal failed");
    };
    await state().sync();
    assert.deepEqual(calls("list"), []);
    assert.equal(state().syncError, "OneDrive renewal failed");
    assert.ok(state().microsoft, "a transient failure does not disconnect");
  });

  it("the Worker says signed out while renewing: the drive is disconnected here and a toast says so", async () => {
    useDropStore.setState({ microsoft: microsoft({ expiresAt: Date.now() - 1 }) });
    fake.renew = async (provider) => {
      fake.renewal?.(provider, null);
      throw new Error("signed out");
    };
    await state().sync();
    assert.equal(state().microsoft, null);
    assert.deepEqual(calls("list"), []);
    assert.equal(fake.toasts.filter((entry) => entry.kind === "error").length, 1);
  });

  it("a delete with a lapsed token renews first, then deletes", async () => {
    seed([record("a", "2026-10-01T10:00:00.000Z", [ref("microsoft", "m-a")], { microsoft: "r1" })]);
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    useDropStore.setState({ google: null, microsoft: microsoft({ expiresAt: Date.now() - 1 }) });
    fake.renew = async () => "fresh";
    assert.equal(await state().remove(["a"]), null);
    assert.deepEqual(
      fake.calls.slice(0, 2).map((call) => call.op),
      ["renew", "delete"],
    );
    assert.deepEqual(ids(), []);
    await settle();
  });
});

/** Just enough of a browser page for hydrate(). */
function pageAt(url: string): void {
  class Storage {
    getItem() {
      return null;
    }
    setItem() {}
    removeItem() {}
  }
  Object.assign(globalThis, {
    window: { location: { href: url }, history: { state: null, replaceState() {} }, matchMedia: () => ({ matches: false }) },
    localStorage: new Storage(),
    sessionStorage: new Storage(),
    document: { cookie: "", documentElement: { classList: { toggle() {} }, style: {} } },
  });
}

describe("store load: stored sessions and the Worker's answer", () => {
  beforeEach(() => {
    seed();
    useDropStore.setState({ hydrated: false, google: null, microsoft: null });
    pageAt("https://drop.example/");
  });

  it("a lapsed stored session the Worker no longer knows is dropped with a signed-out toast", async () => {
    fake.secret = { google: null, microsoft: microsoft({ expiresAt: Date.now() - 60_000 }) };
    fake.tokens = async () => ({ google: null, microsoft: { error: "invalid_grant" } });
    await state().hydrate();
    await state().sync();
    assert.equal(state().microsoft, null);
    assert.equal(fake.toasts.filter((entry) => entry.kind === "error").length, 1);
    assert.deepEqual(calls("list"), []);
  });

  it("a fresh stored session is used without asking the Worker", async () => {
    fake.secret = { google: null, microsoft: microsoft() };
    put("microsoft", "m-a", "a", "2026-10-01T10:00:00.000Z");
    await state().hydrate();
    await state().sync();
    assert.deepEqual(calls("token"), []);
    assert.equal(state().microsoft?.accessToken, "m-token");
    assert.deepEqual(ids(), ["a"], "the drive's note is listed with the stored token");
  });

  it("a session issued to another client ID is not used", async () => {
    fake.secret = { google: google({ clientId: "someone-else" }), microsoft: null };
    await state().hydrate();
    assert.equal(state().google, null);
  });
});
