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
