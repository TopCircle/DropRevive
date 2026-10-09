import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { buildMeta } from "./meta.ts";
import type { DropRecord, MicrosoftSession, Shelf } from "./types.ts";

// The real store, with the browser, the Worker and both drives swapped for in-memory fakes.
register("./store.test-hooks.mjs", import.meta.url);
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
const { fake } = await import("./store.test-fakes.ts");
const { useDropStore } = await import("./store.ts");

const SHELVES_KEY = "droprevive.shelves";
const session = (clientId: string): MicrosoftSession => ({ accessToken: "token", expiresAt: Date.now() + 3_600_000, clientId, via: "server" });

function metaText(id: string): string {
  return JSON.stringify(
    buildMeta({ id, kind: "text", createdAt: "2026-10-01T10:00:00.000Z", deviceId: "d1", deviceName: "Laptop", text: `note ${id}`, size: 6 }),
  );
}

function record(id: string, refs: DropRecord["refs"], folders: DropRecord["folders"]): DropRecord {
  const revs = Object.fromEntries(refs.map((ref) => [ref.provider, "r1"]));
  return { id, kind: "text", createdAt: "2026-10-01T10:00:00.000Z", deviceId: "d1", deviceName: "Laptop", text: `note ${id}`, size: 6, refs, revs, folders };
}

const SHELVES: Shelf[] = [
  { id: "Work", name: "Work", provider: "microsoft" },
  { id: "Plans", name: "Plans", provider: "microsoft", state: "pending" },
  { id: "Old", name: "Old", provider: "microsoft", state: "removed" },
  { id: "Work", name: "Work", provider: "google" },
  { id: "Photos", name: "Photos", provider: "google" },
];

/**
 * OneDrive holds folders Work and Old with notes a and b in Work; Google holds Work and
 * Photos with note b in Photos. Locally both drives are connected and in sync with that.
 */
function seed() {
  fake.reset();
  fake.drives.microsoft.folders = new Set(["Work", "Old"]);
  fake.drives.microsoft.files.set("m-a", { id: "m-a", text: metaText("a"), modifiedTime: "r1", shelf: "Work" });
  fake.drives.microsoft.files.set("m-b", { id: "m-b", text: metaText("b"), modifiedTime: "r1", shelf: "Work" });
  fake.drives.google.folders = new Set(["Work", "Photos"]);
  fake.drives.google.files.set("g-b", { id: "g-b", text: metaText("b"), modifiedTime: "r1", shelf: "Photos" });
  const items = [
    record("a", [{ provider: "microsoft", metaId: "m-a", metaName: "d_a.json", shelf: "Work" }], { microsoft: "Work" }),
    record(
      "b",
      [
        { provider: "google", metaId: "g-b", metaName: "d_b.json", shelf: "Photos" },
        { provider: "microsoft", metaId: "m-b", metaName: "d_b.json", shelf: "Work" },
      ],
      { google: "Photos", microsoft: "Work" },
    ),
  ];
  fake.storage.set(SHELVES_KEY, structuredClone(SHELVES));
  useDropStore.setState({
    hydrated: true,
    busy: false,
    google: { ...session("google-client"), email: "me@gmail.com" },
    microsoft: { ...session("microsoft-client"), username: "me@outlook.com" },
    items,
    shelves: structuredClone(SHELVES),
    syncError: null,
  });
}

const state = () => useDropStore.getState();
const names = (provider: string) => state().shelves.filter((shelf) => shelf.provider === provider).map((shelf) => shelf.id).sort();
const item = (id: string) => state().items.find((entry) => entry.id === id)!;

describe("store: disconnecting a drive forgets its folders here", () => {
  beforeEach(seed);

  it("a confirmed disconnect removes only that drive's folders (every state), saved, and its items' folders", async () => {
    await state().disconnect("microsoft");
    await state().sync();
    assert.equal(state().microsoft, null);
    assert.deepEqual(names("microsoft"), []);
    assert.deepEqual(names("google"), ["Photos", "Work"]);
    assert.deepEqual(
      (fake.storage.get(SHELVES_KEY) as Shelf[]).map((shelf) => `${shelf.provider}:${shelf.id}`).sort(),
      ["google:Photos", "google:Work"],
    );
    assert.deepEqual(item("a").folders, {});
    assert.deepEqual(item("b").folders, { google: "Photos" });
    // The files are still on OneDrive, so the refs stay; only their folder is forgotten.
    assert.deepEqual(item("a").refs, [{ provider: "microsoft", metaId: "m-a", metaName: "d_a.json" }]);
    assert.equal(item("b").refs.find((ref) => ref.provider === "google")?.shelf, "Photos");
    assert.deepEqual(fake.writes(), [], "nothing is written to either drive");
  });

  it("a failed logout keeps the drive, its folders and its items' folders", async () => {
    fake.logout = async () => {
      throw new Error("offline");
    };
    const items = state().items;
    await state().disconnect("microsoft");
    assert.equal(state().microsoft?.username, "me@outlook.com");
    assert.deepEqual(state().shelves, SHELVES);
    assert.deepEqual(fake.storage.get(SHELVES_KEY), SHELVES);
    assert.equal(state().items, items);
    assert.equal(fake.toasts.at(-1)?.kind, "error");
    assert.deepEqual(fake.writes(), []);
  });

  it("after reconnecting, a sync lists the drive's real folders again and puts items back in them, without writing", async () => {
    await state().disconnect("microsoft");
    await state().sync();
    fake.calls = [];
    useDropStore.setState({ microsoft: { ...session("microsoft-client"), username: "me@outlook.com" } });
    await state().sync();
    // What the cloud has: Work and Old. Plans was never created there, so it's gone.
    assert.deepEqual(names("microsoft"), ["Old", "Work"]);
    assert.ok(state().shelves.every((shelf) => shelf.state === undefined));
    assert.deepEqual(names("google"), ["Photos", "Work"]);
    assert.deepEqual(item("a").folders, { microsoft: "Work" });
    assert.deepEqual(item("b").folders, { google: "Photos", microsoft: "Work" });
    assert.equal(item("a").refs[0]?.shelf, "Work");
    assert.ok(fake.calls.some((call) => call.drive === "microsoft" && call.op === "list"));
    assert.deepEqual(fake.writes(), [], "no folder created, moved or removed on reconnect");
    assert.equal(state().syncError, null);
  });

  it("a sync that was already running doesn't write the old folder list back", async () => {
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const running = state().sync();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await state().disconnect("microsoft");
    assert.deepEqual(names("microsoft"), []);
    fake.hold = null;
    release();
    await running;
    await state().sync();
    assert.deepEqual(names("microsoft"), []);
    assert.deepEqual(names("google"), ["Photos", "Work"]);
    assert.deepEqual(item("a").folders, {});
    assert.deepEqual(fake.writes("microsoft"), []);
  });
});

const cloudShelf = (drive: "google" | "microsoft", id: string) => fake.drives[drive].files.get(id)?.shelf ?? "(main)";

describe("store: phone multi-select", () => {
  beforeEach(seed);

  it("a new query or filter drops the selection; the same value keeps it; leaving multi-select clears it", () => {
    state().setSelecting(true);
    state().setSelected(["a"]);
    state().setQuery("");
    assert.deepEqual(state().selected, ["a"], "same query: kept");
    state().setQuery("note");
    assert.deepEqual(state().selected, []);
    assert.equal(state().selecting, true, "still in multi-select, with nothing selected");
    for (const change of [() => state().setKindFilter("text"), () => state().setProviderFilter("google"), () => state().setDateFilter("7")]) {
      state().setSelected(["a", "b"]);
      change();
      assert.deepEqual(state().selected, []);
    }
    state().setSelected(["b"]);
    state().setSelecting(false);
    assert.deepEqual(state().selected, []);
    state().setQuery("");
    state().setKindFilter("all");
    state().setProviderFilter("all");
    state().setDateFilter("all");
  });

  it("batch move to the main folder moves every copy on both drives, then reports them moved", async () => {
    const result = await state().moveItems(["a", "b"], null);
    assert.deepEqual(result.moved.sort(), ["a", "b"]);
    assert.deepEqual([result.pending, result.skipped, result.already], [[], [], []]);
    assert.equal(cloudShelf("microsoft", "m-a"), "(main)");
    assert.equal(cloudShelf("microsoft", "m-b"), "(main)");
    assert.equal(cloudShelf("google", "g-b"), "(main)");
    assert.deepEqual(item("b").folders, {});
  });

  it("a folder that exists on only one drive: items with a copy on the other drive stay put, nothing is written", async () => {
    const result = await state().moveItems(["a", "b"], "Photos");
    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.skipped.sort(), ["a", "b"], "a lives on OneDrive only; b has a OneDrive copy; OneDrive has no Photos");
    assert.deepEqual(result.missingOn, ["microsoft"]);
    assert.deepEqual(fake.writes(), []);
    assert.equal(cloudShelf("google", "g-b"), "Photos");
  });

  it("a folder on both drives: what is already there is left alone, the rest moves", async () => {
    const result = await state().moveItems(["a", "b"], "Work");
    assert.deepEqual(result.already, ["a"]);
    assert.deepEqual(result.moved, ["b"]);
    assert.equal(cloudShelf("google", "g-b"), "Work");
    assert.equal(cloudShelf("microsoft", "m-b"), "Work");
    assert.ok(!fake.writes().some((call) => call.op === "move" && call.arg?.startsWith("m-a")), "a was not touched");
  });

  it("a move the drive refuses is reported pending and stays wanted, so the next sync retries it", async () => {
    fake.failing.add("g-b");
    const result = await state().moveItems(["b"], null);
    assert.deepEqual(result.pending, ["b"]);
    assert.equal(cloudShelf("microsoft", "m-b"), "(main)", "the OneDrive copy moved");
    assert.equal(cloudShelf("google", "g-b"), "Photos", "the Google copy did not");
    assert.deepEqual(item("b").folders, {}, "still wanted in the main folder");
    fake.failing.clear();
    await state().sync();
    assert.equal(cloudShelf("google", "g-b"), "(main)", "retried and done");
  });

  it("batch delete with one refusal: the rest is deleted from the drives, the refused one stays listed", async () => {
    fake.failing.add("m-a");
    await assert.rejects(state().remove(["a", "b"]));
    const left = state().items.map((entry) => entry.id);
    assert.deepEqual(left, ["a"]);
    assert.equal(fake.drives.microsoft.files.has("m-a"), true);
    assert.equal(fake.drives.microsoft.files.has("m-b"), false);
    assert.equal(fake.drives.google.files.has("g-b"), false);
  });
});

/** Just enough of a browser page for hydrate(): URL, history, storage, theme. */
function pageAt(url: string) {
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

const lapsed = (): MicrosoftSession => ({ accessToken: "old", expiresAt: Date.now() - 60_000, clientId: "microsoft-client", via: "server", username: "me@outlook.com" });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const setOnline = (value: boolean) => Object.defineProperty(globalThis.navigator, "onLine", { value, configurable: true });

describe("store: no false 「网络中断」 around token refresh", () => {
  beforeEach(() => {
    seed();
    setOnline(true);
    // Folders already in step with the cloud, so a sync has nothing to create or remove.
    const inStep = SHELVES.filter((shelf) => !shelf.state);
    fake.storage.set(SHELVES_KEY, structuredClone(inStep));
    useDropStore.setState({ hydrated: false, google: null, microsoft: null, syncError: null, online: true, shelves: structuredClone(inStep) });
  });

  it("right after load, the first sync waits for the Worker's /token answer and then uses it", async () => {
    pageAt("https://drop.example/");
    fake.secret = { google: null, microsoft: lapsed() };
    let answer!: (reply: { google: null; microsoft: { access_token: string; expires_in: number } }) => void;
    fake.tokens = () => new Promise((resolve) => (answer = resolve));
    await state().hydrate();
    const run = state().sync(); // what the page does as soon as it's hydrated
    await tick();
    assert.deepEqual(
      fake.calls.filter((call) => call.op !== "token"),
      [],
      "no renew and no drive request ahead of the Worker's answer",
    );
    answer({ google: null, microsoft: { access_token: "fresh", expires_in: 3600 } });
    await run;
    assert.equal(state().microsoft?.accessToken, "fresh");
    assert.ok(fake.calls.some((call) => call.drive === "microsoft" && call.op === "list"));
    assert.equal(fake.calls.filter((call) => call.op === "renew").length, 0);
    assert.equal(state().syncError, null);
  });

  it("a slow renewal mid-sync (e.g. the 1 s stale_grant retry) ends in a normal sync, no warning", async () => {
    useDropStore.setState({ hydrated: true, microsoft: lapsed() });
    fake.renew = async () => {
      await tick(1100);
      return "fresh";
    };
    await state().sync();
    assert.equal(fake.calls.filter((call) => call.op === "renew").length, 1);
    assert.ok(fake.calls.some((call) => call.drive === "microsoft" && call.op === "list"));
    assert.equal(state().syncError, null);
  });

  it("truly offline: no drive request, the store says offline (the page shows the offline banner)", async () => {
    useDropStore.setState({ hydrated: true, microsoft: session("microsoft-client") });
    setOnline(false);
    await state().sync();
    assert.equal(state().online, false);
    assert.deepEqual(fake.calls, []);
    setOnline(true);
  });
});
