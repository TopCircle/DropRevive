import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoreCache,
  cookieKeyState,
  drivesEnabled,
  envValue,
  pickConfigEnv,
  resolveClientIds,
  resolveConfigEnv,
  STORE_CACHE_MS,
} from "./runtime-config.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");

test("placeholders count as unset", () => {
  for (const raw of [undefined, null, "", "  ", "none", "NONE", " None ", "-"]) assert.equal(envValue(raw), "", String(raw));
  assert.equal(envValue("  abc "), "abc");
});

test("client IDs: Worker value first, then the build value", () => {
  assert.deepEqual(resolveClientIds({ GOOGLE_CLIENT_ID: "g-env", MS_CLIENT_ID: "m-env" }, { google: "g-build", microsoft: "m-build" }), {
    googleClientId: "g-env",
    msClientId: "m-env",
  });
  assert.deepEqual(resolveClientIds({}, { google: " g-build ", microsoft: "m-build" }), { googleClientId: "g-build", msClientId: "m-build" });
  assert.deepEqual(resolveClientIds({ GOOGLE_CLIENT_ID: "none" }, { google: "g-build" }), { googleClientId: "g-build", msClientId: "" });
  assert.deepEqual(resolveClientIds({}, {}), { googleClientId: "", msClientId: "" });
});

test("cookie key must decode to 32 bytes; base64 and base64url both work", () => {
  assert.equal(cookieKeyState(KEY), "ok");
  assert.equal(cookieKeyState(KEY.replace(/=+$/, "")), "ok");
  assert.equal(cookieKeyState(Buffer.alloc(32, 250).toString("base64url")), "ok");
  assert.equal(cookieKeyState(undefined), "missing");
  assert.equal(cookieKeyState("none"), "missing");
  assert.equal(cookieKeyState(Buffer.alloc(16).toString("base64")), "invalid");
  assert.equal(cookieKeyState("not base64 at all!"), "invalid");
  assert.equal(cookieKeyState("a".repeat(44)), "invalid");
});

test("pickConfigEnv keeps only the six settings", () => {
  const env = pickConfigEnv({ GOOGLE_CLIENT_ID: "g", PATH: "/bin", DRIVE_COOKIE_KEY: "k" });
  assert.deepEqual(Object.keys(env).sort(), [
    "ALLOWED_ORIGINS",
    "DRIVE_COOKIE_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
  ]);
  assert.equal(env.GOOGLE_CLIENT_ID, "g");
});

test("drivesEnabled: each drive needs its ID and secret; DRIVE_COOKIE_KEY gates both", async () => {
  const { drivesEnabled } = await import("./runtime-config.ts");
  const full = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs", MS_CLIENT_ID: "m", MS_CLIENT_SECRET: "ms", DRIVE_COOKIE_KEY: KEY };
  assert.deepEqual(drivesEnabled(full), { google: true, microsoft: true });
  assert.deepEqual(drivesEnabled({}), { google: false, microsoft: false });
  assert.deepEqual(drivesEnabled({ ...full, GOOGLE_CLIENT_SECRET: "None" }), { google: false, microsoft: true });
  assert.deepEqual(drivesEnabled({ ...full, MS_CLIENT_ID: " none " }), { google: true, microsoft: false });
  for (const DRIVE_COOKIE_KEY of [undefined, "none", "short"]) {
    assert.deepEqual(drivesEnabled({ ...full, DRIVE_COOKIE_KEY }), { google: false, microsoft: false });
  }
  // Build-time ID counts as the ID; the secret still has to be on the Worker.
  const { GOOGLE_CLIENT_ID: _g, ...noGoogleId } = full;
  assert.deepEqual(drivesEnabled(noGoogleId, { google: "g-build" }), { google: true, microsoft: true });
  assert.deepEqual(drivesEnabled({ DRIVE_COOKIE_KEY: KEY }, { google: "g-build", microsoft: "m-build" }), { google: false, microsoft: false });
});

const secret = (value: string) => {
  const binding = { calls: 0, get: async () => (binding.calls++, value) };
  return binding;
};
const failing = () => {
  const binding = {
    calls: 0,
    get: async (): Promise<string> => {
      binding.calls++;
      throw new Error("Secret not found");
    },
  };
  return binding;
};

test("resolveConfigEnv: Secrets Store first, then Worker secret, then build ID", async () => {
  clearStoreCache();
  const { env, sources } = await resolveConfigEnv(
    {
      SS_GOOGLE_CLIENT_SECRET: secret("g-store"),
      GOOGLE_CLIENT_SECRET: "g-worker",
      MS_CLIENT_SECRET: "m-worker",
      SS_DRIVE_COOKIE_KEY: secret(KEY),
      ALLOWED_ORIGINS: "https://a.example",
      SS_ALLOWED_ORIGINS: secret("https://ignored.example"),
    },
    { google: "g-build" },
  );
  assert.equal(env.GOOGLE_CLIENT_SECRET, "g-store");
  assert.equal(env.MS_CLIENT_SECRET, "m-worker");
  assert.equal(env.DRIVE_COOKIE_KEY, KEY);
  assert.equal(env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(env.ALLOWED_ORIGINS, "https://a.example");
  assert.deepEqual(sources, {
    GOOGLE_CLIENT_ID: "build",
    GOOGLE_CLIENT_SECRET: "store",
    MS_CLIENT_ID: "off",
    MS_CLIENT_SECRET: "worker",
    DRIVE_COOKIE_KEY: "store",
  });
  assert.deepEqual(resolveClientIds(env, { google: "g-build" }), { googleClientId: "g-build", msClientId: "" });
});

test("resolveConfigEnv: a throwing binding is unset (store-error), not the Worker secret", async () => {
  clearStoreCache();
  const { env, sources } = await resolveConfigEnv({
    SS_GOOGLE_CLIENT_SECRET: failing(),
    GOOGLE_CLIENT_SECRET: "g-worker",
    GOOGLE_CLIENT_ID: "g-id",
    SS_DRIVE_COOKIE_KEY: failing(),
    DRIVE_COOKIE_KEY: KEY,
  });
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(sources.GOOGLE_CLIENT_SECRET, "store-error");
  assert.equal(sources.DRIVE_COOKIE_KEY, "store-error");
  assert.deepEqual(drivesEnabled(env), { google: false, microsoft: false });
});

test("resolveConfigEnv: absent bindings and empty / none store values fall through", async () => {
  clearStoreCache();
  const plain = await resolveConfigEnv({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", DRIVE_COOKIE_KEY: KEY, SS_MS_CLIENT_ID: "a string, not a binding" });
  assert.equal(plain.sources.GOOGLE_CLIENT_SECRET, "worker");
  assert.equal(plain.sources.MS_CLIENT_ID, "off");
  assert.deepEqual(drivesEnabled(plain.env), { google: true, microsoft: false });
  const empty = await resolveConfigEnv({ SS_MS_CLIENT_SECRET: secret("none"), MS_CLIENT_SECRET: "m-worker", SS_MS_CLIENT_ID: secret("") });
  assert.equal(empty.env.MS_CLIENT_SECRET, "m-worker");
  assert.equal(empty.sources.MS_CLIENT_SECRET, "worker");
  assert.equal(empty.sources.MS_CLIENT_ID, "off");
  const nothing = await resolveConfigEnv({});
  assert.ok(Object.values(nothing.sources).every((source) => source === "off"));
});

test("resolveConfigEnv: store reads are cached per isolate for STORE_CACHE_MS", async () => {
  clearStoreCache();
  const binding = secret("g-store");
  const bad = failing();
  const env = { SS_GOOGLE_CLIENT_SECRET: binding, SS_MS_CLIENT_SECRET: bad };
  await resolveConfigEnv(env, {}, { now: 1_000 });
  await resolveConfigEnv(env, {}, { now: 1_000 + STORE_CACHE_MS - 1 });
  assert.equal(binding.calls, 1);
  assert.equal(bad.calls, 1);
  await resolveConfigEnv(env, {}, { now: 1_000 + STORE_CACHE_MS });
  assert.equal(binding.calls, 2);
  assert.equal(bad.calls, 2);
  // A different binding object (new deploy) is read again at once.
  const fresh = secret("g-new");
  const next = await resolveConfigEnv({ SS_GOOGLE_CLIENT_SECRET: fresh }, {}, { now: 1_000 + STORE_CACHE_MS + 1 });
  assert.equal(fresh.calls, 1);
  assert.equal(next.env.GOOGLE_CLIENT_SECRET, "g-new");
  assert.equal(STORE_CACHE_MS, 60_000);
});
