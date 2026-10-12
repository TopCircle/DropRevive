import assert from "node:assert/strict";
import test from "node:test";
import { cookieKeyState, envValue, pickConfigEnv, resolveClientIds } from "./runtime-config.ts";

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
