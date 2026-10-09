import assert from "node:assert/strict";
import test from "node:test";
import * as env from "./client-env.ts";

test("applyClientConfig updates the live bindings every importer sees", () => {
  env.applyClientConfig({ googleClientId: " g-runtime ", msClientId: "" });
  assert.equal(env.GOOGLE_CLIENT_ID, "g-runtime");
  assert.equal(env.googleConfigured, true);
  assert.equal(env.MS_CLIENT_ID, "");
  assert.equal(env.microsoftConfigured, false);

  env.applyClientConfig({ googleClientId: "", msClientId: "m-runtime" });
  assert.equal(env.googleConfigured, false);
  assert.equal(env.microsoftConfigured, true);
});

test("a missing config (loader failed) keeps the current values", () => {
  env.applyClientConfig({ googleClientId: "g", msClientId: "m" });
  env.applyClientConfig(null);
  assert.equal(env.GOOGLE_CLIENT_ID, "g");
  assert.equal(env.MS_CLIENT_ID, "m");
});
