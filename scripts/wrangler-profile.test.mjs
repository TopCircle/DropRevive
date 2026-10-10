import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripJsonc } from "./deploy-self.mjs";
import {
  PRODUCTION_HOST,
  PRODUCTION_WORKER,
  PUBLIC_ONLY_KEYS,
  PUBLIC_WORKER,
  REQUIRED_SECRETS,
  mergeLikeNitro,
  profileFrom,
  profileMismatch,
  profileOverrides,
  stripPublicOnly,
} from "./wrangler-profile.mjs";

const tracked = JSON.parse(stripJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
/** What nitro writes to .output/server/wrangler.json (main/assets added by nitro). */
const generate = (profile) =>
  mergeLikeNitro({ main: "index.mjs", assets: { directory: "../public" } }, mergeLikeNitro(profileOverrides(profile), tracked));

/** check-profile.mjs production: the production build without the public-only keys. */
const production = () => stripPublicOnly(generate("production"));

/** deploy-staging.mjs: the public build renamed, without the public-only keys. */
function staging(name) {
  const config = stripPublicOnly(structuredClone(generate("public")));
  config.name = name;
  delete config.routes;
  delete config.route;
  config.workers_dev = true;
  return config;
}

test("tracked wrangler.jsonc is the public profile: droprevive on workers.dev, no route", () => {
  assert.equal(tracked.name, PUBLIC_WORKER);
  assert.equal(tracked.workers_dev, true);
  assert.equal(tracked.preview_urls, false);
  assert.deepEqual(tracked.secrets, { required: REQUIRED_SECRETS });
  assert.equal(tracked.routes, undefined);
  assert.equal(tracked.route, undefined);
  assert.equal(JSON.stringify(tracked).includes(PRODUCTION_HOST), false);
});

test("migration tags and Durable Object bindings stay what production already has", () => {
  assert.deepEqual(tracked.migrations, [
    { tag: "v1-transfer-room", new_sqlite_classes: ["TransferRoom", "TransferGate"] },
  ]);
  assert.deepEqual(tracked.durable_objects.bindings, [
    { name: "TRANSFER_ROOM", class_name: "TransferRoom" },
    { name: "TRANSFER_GATE", class_name: "TransferGate" },
  ]);
});

test("public profile generates a workers.dev config with preview URLs off and all secrets required", () => {
  const config = generate("public");
  assert.equal(profileMismatch(config, "public", tracked.migrations), null);
  assert.equal(config.name, PUBLIC_WORKER);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.secrets, { required: REQUIRED_SECRETS });
});

test("public check accepts the name the button picks (the repo name) but never dropreceive", () => {
  const renamed = { ...generate("public"), name: "droprevive-deploy-test" };
  assert.equal(profileMismatch(renamed, "public", tracked.migrations), null);
  assert.match(profileMismatch({ ...renamed, name: "dropreceive" }, "public", tracked.migrations) ?? "", /production/);
  assert.match(profileMismatch({ ...renamed, name: "" }, "public", tracked.migrations) ?? "", /no name/);
});

test("public check requires workers.dev on, no routes, preview URLs off, every secret declared", () => {
  const base = generate("public");
  for (const workers_dev of [false, undefined]) {
    assert.match(profileMismatch({ ...base, workers_dev }, "public", tracked.migrations) ?? "", /workers_dev/);
  }
  const routed = { ...base, routes: [{ pattern: "drop.example.com", custom_domain: true }] };
  assert.match(profileMismatch(routed, "public", tracked.migrations) ?? "", /routes/);
  assert.match(profileMismatch({ ...base, preview_urls: true }, "public", tracked.migrations) ?? "", /preview_urls/);
  const fewer = { ...base, secrets: { required: REQUIRED_SECRETS.slice(1) } };
  assert.match(profileMismatch(fewer, "public", tracked.migrations) ?? "", /GOOGLE_CLIENT_ID/);
  const none = { ...base };
  delete none.secrets;
  assert.match(profileMismatch(none, "public", tracked.migrations) ?? "", /secrets/);
});

test("production profile generates dropreceive + custom domain + identical migrations", () => {
  const config = production();
  assert.equal(config.name, PRODUCTION_WORKER);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [{ pattern: PRODUCTION_HOST, custom_domain: true }]);
  assert.deepEqual(config.migrations, tracked.migrations);
  assert.deepEqual(config.durable_objects, tracked.durable_objects);
  assert.equal(profileMismatch(config, "production", tracked.migrations), null);
  for (const key of PUBLIC_ONLY_KEYS) assert.equal(key in config, false, key);
  // Unstripped (check-profile.mjs not run) is refused.
  assert.match(profileMismatch(generate("production"), "production", tracked.migrations) ?? "", /must not carry/);
});

test("production and staging configs are exactly what they were before the button (b8d8e19)", () => {
  const keys = (config) => Object.keys(config).sort();
  const expected = ["assets", "compatibility_date", "compatibility_flags", "durable_objects", "main", "migrations", "name", "routes", "workers_dev"];
  assert.deepEqual(keys(production()), expected);
  assert.deepEqual(keys(staging("example-staging")), expected.filter((key) => key !== "routes"));
});

test("staging is the public build renamed", () => {
  const config = staging("example-staging");
  assert.equal(profileMismatch(config, "staging", tracked.migrations, "example-staging"), null);
  assert.match(profileMismatch(staging("dropreceive"), "staging", tracked.migrations, "dropreceive") ?? "", /production/);
});

test("a build for one profile is refused as another", () => {
  assert.ok(profileMismatch(generate("public"), "production", tracked.migrations));
  assert.ok(profileMismatch(production(), "public", tracked.migrations));
  assert.ok(profileMismatch(generate("public"), "staging", tracked.migrations, PUBLIC_WORKER));
  const lost = { ...production(), migrations: [] };
  assert.match(profileMismatch(lost, "production", tracked.migrations) ?? "", /migrations/);
});

test("DROP_PROFILE parsing", () => {
  assert.equal(profileFrom(undefined), "public");
  assert.equal(profileFrom(""), "public");
  assert.equal(profileFrom("Production"), "production");
  assert.throws(() => profileFrom("prod"));
});

test("mergeLikeNitro follows defu: left wins, objects merge, arrays concatenate", () => {
  assert.deepEqual(mergeLikeNitro({ a: 1, o: { x: 1 }, l: [1] }, { a: 2, b: 3, o: { y: 2 }, l: [2] }), {
    a: 1,
    b: 3,
    o: { x: 1, y: 2 },
    l: [1, 2],
  });
  assert.deepEqual(mergeLikeNitro({ a: undefined, f: false }, { a: 5, f: true }), { a: 5, f: false });
});

test(".dev.vars.example declares exactly the required secrets, blank, and is tracked", () => {
  const text = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
  const active = text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.deepEqual(active, REQUIRED_SECRETS.map((name) => `${name}=`));
  // eslint-disable-next-line no-control-regex
  assert.equal(/[^\x00-\x7f]/.test(text), false, "ASCII only");
  const root = new URL("..", import.meta.url).pathname;
  assert.throws(() => execFileSync("git", ["check-ignore", "-q", ".dev.vars.example"], { cwd: root }), "must not be gitignored");
});

test("package.json: deploy checks the public profile; every secret has a description", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.deploy, "node scripts/check-profile.mjs public && wrangler deploy");
  assert.match(pkg.scripts["deploy:production"], /DROP_PROFILE=production .*check-profile\.mjs production && wrangler deploy$/);
  assert.deepEqual(Object.keys(pkg.cloudflare.bindings).sort(), [...REQUIRED_SECRETS].sort());
  for (const name of REQUIRED_SECRETS) assert.ok(pkg.cloudflare.bindings[name].description.length > 20, name);
});
