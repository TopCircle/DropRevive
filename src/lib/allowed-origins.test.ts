import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_DEV_ORIGINS,
  allowedMode,
  isAllowedOrigin,
  malformedWarning,
  parseAllowedOrigins,
  refusalReason,
} from "./allowed-origins.ts";

describe("parseAllowedOrigins", () => {
  it("treats missing, blank and none as unset (same-origin only)", () => {
    for (const raw of [undefined, null, "", "  ", ",,,", "none", " NONE ", "-"]) {
      const parsed = parseAllowedOrigins(raw as string | null | undefined);
      assert.equal(parsed.missing, true);
      assert.deepEqual(parsed.origins, []);
      assert.deepEqual(parsed.invalid, []);
    }
  });

  it("accepts comma-separated https origins and drops duplicates", () => {
    const parsed = parseAllowedOrigins(
      " https://staging.example.com ,https://drop.example.com, https://staging.example.com/ ",
    );
    assert.equal(parsed.missing, false);
    assert.deepEqual(parsed.origins, ["https://staging.example.com", "https://drop.example.com"]);
    assert.deepEqual(parsed.invalid, []);
  });

  it("rejects entries that are not a bare origin", () => {
    const parsed = parseAllowedOrigins(
      "https://ok.example,https://bad.example/path,ftp://x.example,not-a-url,https://user:pass@host.example",
    );
    assert.deepEqual(parsed.origins, ["https://ok.example"]);
    assert.equal(parsed.invalid.length, 4);
    assert.equal(parsed.missing, false);
  });

  it("keeps an explicit port", () => {
    const parsed = parseAllowedOrigins("http://localhost:8080,https://app.example:8443");
    assert.deepEqual(parsed.origins, ["http://localhost:8080", "https://app.example:8443"]);
  });
});

describe("isAllowedOrigin", () => {
  it("always allows local dev origins even when the variable is missing", () => {
    const empty = parseAllowedOrigins(undefined);
    for (const origin of LOCAL_DEV_ORIGINS) {
      assert.equal(isAllowedOrigin(origin, empty), true);
    }
    assert.equal(isAllowedOrigin("https://staging.example.com", empty), false);
  });

  it("allows only listed origins besides local dev", () => {
    const allowed = parseAllowedOrigins("https://staging.example.com");
    assert.equal(isAllowedOrigin("https://staging.example.com", allowed), true);
    assert.equal(isAllowedOrigin("https://evil.example", allowed), false);
    assert.equal(isAllowedOrigin("http://localhost:8080", allowed), true);
  });
});

describe("isAllowedOrigin with the site's own origin", () => {
  const site = "https://droprevive.someone.workers.dev";
  it("unset: allows exactly the request URL's origin, nothing else", () => {
    for (const raw of [undefined, "", "none"]) {
      const allowed = parseAllowedOrigins(raw);
      assert.equal(allowedMode(allowed), "same-origin");
      assert.equal(isAllowedOrigin(site, allowed, site), true);
      assert.equal(isAllowedOrigin("https://drop.custom.example", allowed, "https://drop.custom.example"), true);
      assert.equal(isAllowedOrigin("https://evil.example", allowed, site), false);
      assert.equal(isAllowedOrigin("http://droprevive.someone.workers.dev", allowed, site), false);
      assert.equal(isAllowedOrigin(site, allowed), false, "no site origin given: nothing but local dev");
    }
  });

  it("set: the strict list, even for the site's own origin", () => {
    const allowed = parseAllowedOrigins("https://drop.example.com");
    assert.equal(allowedMode(allowed), "list");
    assert.equal(isAllowedOrigin("https://drop.example.com", allowed, "https://drop.example.com"), true);
    assert.equal(isAllowedOrigin(site, allowed, site), false);
  });

  it("only malformed entries: fails closed, even same-origin", () => {
    const allowed = parseAllowedOrigins("droprevive.someone.workers.dev,https://x.example/path");
    assert.equal(allowedMode(allowed), "malformed");
    assert.equal(allowed.missing, false);
    assert.equal(isAllowedOrigin(site, allowed, site), false);
    assert.equal(isAllowedOrigin("http://localhost:8080", allowed, site), true);
  });
});

describe("refusalReason / malformedWarning", () => {
  it("explains a missing variable without echoing secrets", () => {
    const msg = refusalReason("https://evil.example", parseAllowedOrigins(undefined));
    assert.match(msg, /ALLOWED_ORIGINS is not set/);
    assert.match(msg, /https:\/\/evil\.example/);
    assert.doesNotMatch(msg, /secret|token|cookie/i);
  });

  it("explains a list that has only malformed entries", () => {
    const parsed = parseAllowedOrigins("https://x.example/path,oops");
    const msg = refusalReason("https://evil.example", parsed);
    assert.match(msg, /no valid origin/);
    assert.match(msg, /2 malformed/);
  });

  it("lists malformed entries for a one-time warning", () => {
    const warning = malformedWarning(parseAllowedOrigins("https://ok.example,https://bad.example/x"));
    assert.ok(warning);
    assert.match(warning!, /https:\/\/bad\.example\/x/);
    assert.equal(malformedWarning(parseAllowedOrigins("https://ok.example")), null);
  });
});
