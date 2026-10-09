import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  commandName,
  refusalReason,
  routePatterns,
  stripJsonc,
  usesMaintainerRoute,
} from "./deploy-self.mjs";

const MAINTAINER = `{
  // comment
  "name": "dropreceive",
  "routes": [{ "pattern": "drop.habor.dpdns.org", "custom_domain": true }]
}`;

const own = (extra) => JSON.stringify({ name: "my-droprevive", ...extra });

test("jsonc comments are ignored and the maintainer host is recognized", () => {
  assert.equal(stripJsonc(MAINTAINER).includes("comment"), false);
  assert.deepEqual(routePatterns(MAINTAINER), ["drop.habor.dpdns.org"]);
  assert.equal(usesMaintainerRoute(MAINTAINER), true);
  assert.match(refusalReason(MAINTAINER), /dropreceive/);
});

test("own name and own custom domain: allowed", () => {
  const config = own({ routes: [{ pattern: "drop.example.com", custom_domain: true }] });
  assert.equal(usesMaintainerRoute(config), false);
  assert.equal(refusalReason(config), null);
});

test("own name with a string route or a zone route: allowed", () => {
  assert.equal(refusalReason(own({ routes: ["drop.example.com/*"] })), null);
  assert.equal(
    refusalReason(own({ routes: [{ pattern: "drop.example.com/*", zone_name: "example.com" }] })),
    null,
  );
  assert.equal(refusalReason(own({ route: "drop.example.com/*" })), null);
  assert.equal(
    refusalReason(own({ route: { pattern: "drop.example.com", custom_domain: true } })),
    null,
  );
});

test("the maintainer's Worker name is refused even with your own domain", () => {
  const config = JSON.stringify({
    name: "dropreceive",
    routes: [{ pattern: "drop.example.com", custom_domain: true }],
  });
  assert.match(refusalReason(config), /still named "dropreceive"/);
});

test("a missing Worker name is refused", () => {
  assert.match(refusalReason(JSON.stringify({ routes: ["drop.example.com/*"] })), /no Worker name/);
});

test("the maintainer domain is refused in every route form", () => {
  for (const extra of [
    { routes: [{ pattern: "drop.habor.dpdns.org", custom_domain: true }] },
    { routes: ["drop.habor.dpdns.org/*"] },
    { routes: ["DROP.HABOR.DPDNS.ORG/*"] },
    { routes: [{ pattern: "*.habor.dpdns.org/*", zone_name: "habor.dpdns.org" }] },
    { route: "drop.habor.dpdns.org/*" },
    { route: { pattern: "drop.habor.dpdns.org", custom_domain: true } },
    { routes: ["drop.example.com/*"], route: "drop.habor.dpdns.org/*" },
  ]) {
    assert.match(refusalReason(own(extra)) ?? "", /drop\.habor\.dpdns\.org/, JSON.stringify(extra));
  }
});

test("workers.dev only (workers_dev: true, no routes) is allowed", () => {
  for (const extra of [{ workers_dev: true }, { workers_dev: true, routes: [] }]) {
    assert.equal(refusalReason(own(extra)), null, JSON.stringify(extra));
  }
});

test("the tracked public wrangler.jsonc passes the guard", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.equal(refusalReason(text), null);
  assert.deepEqual(routePatterns(text), []);
});

test("workers.dev only is still refused under the maintainer's Worker name", () => {
  const config = JSON.stringify({ name: "dropreceive", workers_dev: true });
  assert.match(refusalReason(config) ?? "", /dropreceive/);
});

test("no route, no custom domain and no workers.dev is refused", () => {
  for (const extra of [{}, { routes: [] }, { workers_dev: false }]) {
    assert.match(
      refusalReason(own(extra)) ?? "",
      /no route or custom domain/,
      JSON.stringify(extra),
    );
  }
});

test("a route without a pattern is refused", () => {
  assert.match(refusalReason(own({ routes: [{ custom_domain: true }] })) ?? "", /no pattern/);
  assert.match(refusalReason(own({ routes: [42] })) ?? "", /no pattern/);
});

test("unreadable config is refused", () => {
  assert.match(refusalReason("{ not json"), /could not be read/);
});

test("the refusal names the command that was run", () => {
  assert.equal(commandName("deploy"), "node scripts/deploy-self.mjs");
  assert.equal(commandName("deploy:self"), "npm run deploy:self");
  assert.equal(commandName(undefined), "node scripts/deploy-self.mjs");
  assert.equal(commandName("deploy:production"), "node scripts/deploy-self.mjs");
});
