import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SUMMARY_ONLY_HOSTS, setupStatus, type SetupDetails } from "./setup-status.ts";

const KEY = Buffer.alloc(32, 9).toString("base64");
const SITE = "https://droprevive.example.workers.dev";
const FULL = {
  GOOGLE_CLIENT_ID: "g-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "g-secret-value",
  MS_CLIENT_ID: "m-id",
  MS_CLIENT_SECRET: "m-secret-value",
  DRIVE_COOKIE_KEY: KEY,
  ALLOWED_ORIGINS: `${SITE},https://drop.example.com`,
};

const details = (env: Record<string, string | undefined>, url = `${SITE}/setup`, build = {}) => {
  const status = setupStatus(env, url, build);
  assert.equal(status.mode, "details");
  return status as SetupDetails;
};
const states = (status: SetupDetails) => Object.fromEntries(status.items.map((item) => [item.key, item.state]));

test("everything set: all ok, both drives ready, callbacks for this origin", () => {
  const status = details(FULL);
  assert.deepEqual(Object.values(states(status)), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(status.drives, { google: true, microsoft: true });
  assert.equal(status.ready, true);
  assert.deepEqual(status.callbacks, {
    google: `${SITE}/api/drive-auth/google/callback`,
    microsoft: `${SITE}/api/drive-auth/microsoft/callback`,
  });
  assert.equal(status.allowedCount, 2);
});

test("never carries a secret value, the cookie key or the origin list", () => {
  const text = JSON.stringify(setupStatus(FULL, `${SITE}/setup`));
  for (const secret of [FULL.GOOGLE_CLIENT_SECRET, FULL.MS_CLIENT_SECRET, KEY, "drop.example.com"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  // Public client IDs may be shown.
  assert.ok(text.includes(FULL.GOOGLE_CLIENT_ID));
});

test("missing Google ID: flagged, Google not ready, OneDrive still ready", () => {
  const status = details({ ...FULL, GOOGLE_CLIENT_ID: undefined });
  assert.equal(states(status).GOOGLE_CLIENT_ID, "missing");
  assert.deepEqual(status.drives, { google: false, microsoft: true });
  assert.equal(status.ready, true);
});

test("one drive only: the other drive's 'none' values are missing, the site is ready", () => {
  const status = details({ ...FULL, MS_CLIENT_ID: "none", MS_CLIENT_SECRET: "none" });
  assert.equal(states(status).MS_CLIENT_ID, "missing");
  assert.deepEqual(status.drives, { google: true, microsoft: false });
  assert.equal(status.ready, true);
});

test("build-time IDs show as fallback", () => {
  const status = details({ ...FULL, GOOGLE_CLIENT_ID: undefined, MS_CLIENT_ID: undefined }, `${SITE}/setup`, {
    google: "g-build",
    microsoft: "m-build",
  });
  assert.equal(states(status).GOOGLE_CLIENT_ID, "fallback");
  assert.equal(status.items[0].value, "g-build");
  assert.equal(status.ready, true);
});

test("bad cookie key or unlisted origin: nothing is ready", () => {
  const badKey = details({ ...FULL, DRIVE_COOKIE_KEY: Buffer.alloc(31).toString("base64") });
  assert.equal(states(badKey).DRIVE_COOKIE_KEY, "invalid");
  assert.equal(badKey.ready, false);

  const other = details(FULL, "https://elsewhere.example/setup");
  assert.equal(states(other).ALLOWED_ORIGINS, "invalid");
  assert.equal(other.originAllowed, false);
  assert.equal(other.ready, false);

  const unset = details({ ...FULL, ALLOWED_ORIGINS: "none" });
  assert.equal(states(unset).ALLOWED_ORIGINS, "missing");
  assert.equal(unset.ready, false);
});

test("maintainer production host: summary only", () => {
  const status = setupStatus({ ...FULL, ALLOWED_ORIGINS: "https://drop.habor.dpdns.org" }, "https://drop.habor.dpdns.org/setup");
  assert.deepEqual(status, { mode: "summary", ready: true, drives: { google: true, microsoft: true }, attention: 0 });
  const broken = setupStatus({ ALLOWED_ORIGINS: "https://drop.habor.dpdns.org" }, "https://drop.habor.dpdns.org/setup");
  assert.equal(broken.mode, "summary");
  assert.equal(broken.ready, false);
  assert.equal(broken.mode === "summary" && broken.attention, 5);
});

test("summary host matches the production profile's host", () => {
  const profile = readFileSync(new URL("../../scripts/wrangler-profile.mjs", import.meta.url), "utf8");
  const host = /PRODUCTION_HOST = "([^"]+)"/.exec(profile)?.[1];
  assert.deepEqual(SUMMARY_ONLY_HOSTS, [host]);
});
