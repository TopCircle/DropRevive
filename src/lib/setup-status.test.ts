import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SUMMARY_ONLY_HOSTS, clientConfig, readyDrives, setupStatus, type SetupDetails } from "./setup-status.ts";

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

test("missing Google ID: off (optional), Google not ready, OneDrive still ready", () => {
  const status = details({ ...FULL, GOOGLE_CLIENT_ID: undefined });
  assert.equal(states(status).GOOGLE_CLIENT_ID, "off");
  assert.deepEqual(status.drives, { google: false, microsoft: true });
  assert.equal(status.ready, true);
});

test("one drive only: the other drive's 'none' values are off, the site is ready", () => {
  const status = details({ ...FULL, MS_CLIENT_ID: "none", MS_CLIENT_SECRET: "NONE " });
  assert.equal(states(status).MS_CLIENT_ID, "off");
  assert.equal(states(status).MS_CLIENT_SECRET, "off");
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

  const malformed = details({ ...FULL, ALLOWED_ORIGINS: "droprevive.example.workers.dev,https://x.example/path" });
  assert.equal(malformed.originMode, "malformed");
  assert.equal(states(malformed).ALLOWED_ORIGINS, "invalid");
  assert.equal(malformed.invalidOrigins, 2);
  assert.equal(malformed.ready, false);
});

test("fresh deploy with nothing set: every item off, origin same-origin, no drive, nothing invalid", () => {
  const status = details({});
  assert.deepEqual(states(status), {
    GOOGLE_CLIENT_ID: "off",
    GOOGLE_CLIENT_SECRET: "off",
    MS_CLIENT_ID: "off",
    MS_CLIENT_SECRET: "off",
    DRIVE_COOKIE_KEY: "off",
    ALLOWED_ORIGINS: "same-origin",
  });
  assert.equal(status.originMode, "same-origin");
  assert.equal(status.originAllowed, true);
  assert.equal(status.origin, SITE);
  assert.deepEqual(status.drives, { google: false, microsoft: false });
  assert.equal(status.ready, false);
});

test("ALLOWED_ORIGINS unset, empty or none: same-origin, so drives work on any address of this Worker", () => {
  for (const ALLOWED_ORIGINS of [undefined, "", "  ", "none", "None"]) {
    for (const url of [`${SITE}/setup`, "https://drop.custom.example/setup"]) {
      const status = details({ ...FULL, ALLOWED_ORIGINS }, url);
      assert.equal(states(status).ALLOWED_ORIGINS, "same-origin", `${ALLOWED_ORIGINS} ${url}`);
      assert.deepEqual(status.drives, { google: true, microsoft: true });
    }
  }
});

test("a drive needs its ID and secret; the cookie key gates both", () => {
  const cases: [Record<string, string | undefined>, { google: boolean; microsoft: boolean }][] = [
    [{ GOOGLE_CLIENT_SECRET: undefined }, { google: false, microsoft: true }],
    [{ GOOGLE_CLIENT_SECRET: "none" }, { google: false, microsoft: true }],
    [{ GOOGLE_CLIENT_ID: " NONE " }, { google: false, microsoft: true }],
    [{ MS_CLIENT_SECRET: "-" }, { google: true, microsoft: false }],
    [{ MS_CLIENT_ID: "" }, { google: true, microsoft: false }],
    [{ DRIVE_COOKIE_KEY: undefined }, { google: false, microsoft: false }],
    [{ DRIVE_COOKIE_KEY: "none" }, { google: false, microsoft: false }],
    [{ DRIVE_COOKIE_KEY: "not base64 !" }, { google: false, microsoft: false }],
    [{ DRIVE_COOKIE_KEY: Buffer.alloc(16).toString("base64") }, { google: false, microsoft: false }],
  ];
  for (const [change, expected] of cases) {
    assert.deepEqual(readyDrives({ ...FULL, ...change }, `${SITE}/`), expected, JSON.stringify(change));
  }
  const noKey = details({ ...FULL, DRIVE_COOKIE_KEY: undefined });
  assert.equal(states(noKey).DRIVE_COOKIE_KEY, "off");
});

test("clientConfig: IDs kept, each drive flagged on only when it can sign in here", () => {
  assert.deepEqual(clientConfig(FULL, `${SITE}/`), {
    googleClientId: FULL.GOOGLE_CLIENT_ID,
    msClientId: FULL.MS_CLIENT_ID,
    googleEnabled: true,
    msEnabled: true,
  });
  // ID known but secret missing: ID kept (stored sessions still match), drive off.
  assert.deepEqual(clientConfig({ ...FULL, GOOGLE_CLIENT_SECRET: "none" }, `${SITE}/`), {
    googleClientId: FULL.GOOGLE_CLIENT_ID,
    msClientId: FULL.MS_CLIENT_ID,
    googleEnabled: false,
    msEnabled: true,
  });
  // Build-time IDs with nothing else set: both off.
  const bare = clientConfig({}, `${SITE}/`, { google: "g-build", microsoft: "m-build" });
  assert.deepEqual(bare, { googleClientId: "g-build", msClientId: "m-build", googleEnabled: false, msEnabled: false });
  // A list that does not include this address: off (the broker would refuse it).
  assert.equal(clientConfig(FULL, "https://elsewhere.example/").googleEnabled, false);
});

test("maintainer production host: summary only", () => {
  const status = setupStatus({ ...FULL, ALLOWED_ORIGINS: "https://drop.habor.dpdns.org" }, "https://drop.habor.dpdns.org/setup");
  assert.deepEqual(status, { mode: "summary", ready: true, drives: { google: true, microsoft: true }, attention: 0 });
  const broken = setupStatus({ ALLOWED_ORIGINS: "https://drop.habor.dpdns.org" }, "https://drop.habor.dpdns.org/setup");
  assert.equal(broken.mode, "summary");
  assert.equal(broken.ready, false);
  // Unset items are optional ("off"), not problems; only invalid ones need attention.
  assert.equal(broken.mode === "summary" && broken.attention, 0);
  const badKey = setupStatus({ ...FULL, DRIVE_COOKIE_KEY: "short", ALLOWED_ORIGINS: undefined }, "https://drop.habor.dpdns.org/setup");
  assert.deepEqual(badKey, { mode: "summary", ready: false, drives: { google: false, microsoft: false }, attention: 1 });
});

test("summary host matches the production profile's host", () => {
  const profile = readFileSync(new URL("../../scripts/wrangler-profile.mjs", import.meta.url), "utf8");
  const host = /PRODUCTION_HOST = "([^"]+)"/.exec(profile)?.[1];
  assert.deepEqual(SUMMARY_ONLY_HOSTS, [host]);
});
