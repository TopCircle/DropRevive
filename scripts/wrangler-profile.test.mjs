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
  CONFIG_SECRETS,
  ROOT_ONLY_KEYS,
  inProductionOrder,
  mergeLikeNitro,
  profileFrom,
  profileMismatch,
  profileOverrides,
  secretsStoreBindings,
  stripPublicOnly,
  stripRootOnly,
} from "./wrangler-profile.mjs";

const tracked = JSON.parse(stripJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
/** What nitro writes to .output/server/wrangler.json (main/assets overridden by nitro). */
const generate = (profile) =>
  mergeLikeNitro(
    { main: "index.mjs", assets: { binding: "ASSETS", directory: "../public" } },
    mergeLikeNitro(profileOverrides(profile), tracked),
  );

/** check-profile.mjs public: the public build without the custom build. */
const publicBuild = () => stripRootOnly(generate("public"));

/** check-profile.mjs production: the production build without the custom build and public-only keys. */
const production = () => stripPublicOnly(stripRootOnly(generate("production")));

/** deploy-staging.mjs: the public build renamed, without the public-only keys and the custom build. */
function staging(name) {
  const config = stripRootOnly(stripPublicOnly(structuredClone(generate("public"))));
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
  // Deploy first, configure later: no secret is required, so a deploy with none set succeeds.
  assert.equal(tracked.secrets, undefined);
  assert.equal(tracked.routes, undefined);
  assert.equal(tracked.route, undefined);
  assert.equal(JSON.stringify(tracked).includes(PRODUCTION_HOST), false);
});

test("a bare `wrangler deploy` from a clean checkout builds first and uploads nitro's output", () => {
  assert.deepEqual(tracked.build, { command: "npm run build" });
  assert.deepEqual(ROOT_ONLY_KEYS, ["build"]);
  assert.equal(tracked.main, ".output/server/index.mjs");
  assert.deepEqual(tracked.assets, { binding: "ASSETS", directory: ".output/public" });
  // What nitro adds to the generated config for cloudflare_module, so both paths upload the same Worker.
  assert.equal(tracked.no_bundle, true);
  assert.deepEqual(tracked.rules, [{ type: "ESModule", globs: ["**/*.mjs", "**/*.js"] }]);
  // The custom build must not rebuild through the deploy scripts.
  assert.equal(tracked.build.command.includes("deploy"), false);
});

test("a generated config that still carries the custom build is refused in every profile", () => {
  const raw = generate("public");
  assert.ok("build" in raw);
  assert.match(profileMismatch(raw, "public", tracked.migrations) ?? "", /build/);
  const prod = stripPublicOnly(generate("production"));
  assert.match(profileMismatch(prod, "production", tracked.migrations) ?? "", /build/);
  const stage = { ...staging("example-staging"), build: tracked.build };
  assert.match(profileMismatch(stage, "staging", tracked.migrations, "example-staging") ?? "", /build/);
  for (const config of [publicBuild(), production(), staging("example-staging")]) {
    for (const key of ROOT_ONLY_KEYS) assert.equal(key in config, false, key);
  }
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

test("public profile generates a workers.dev config with preview URLs off and no required secrets", () => {
  const config = publicBuild();
  assert.equal(profileMismatch(config, "public", tracked.migrations), null);
  assert.equal(config.name, PUBLIC_WORKER);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal("secrets" in config, false);
});

test("public check accepts the name the button picks (the repo name) but never dropreceive", () => {
  const renamed = { ...publicBuild(), name: "droprevive-deploy-test" };
  assert.equal(profileMismatch(renamed, "public", tracked.migrations), null);
  assert.match(profileMismatch({ ...renamed, name: "dropreceive" }, "public", tracked.migrations) ?? "", /production/);
  assert.match(profileMismatch({ ...renamed, name: "" }, "public", tracked.migrations) ?? "", /no name/);
});

test("public check requires workers.dev on, no routes, preview URLs off, no required secrets", () => {
  const base = publicBuild();
  for (const workers_dev of [false, undefined]) {
    assert.match(profileMismatch({ ...base, workers_dev }, "public", tracked.migrations) ?? "", /workers_dev/);
  }
  const routed = { ...base, routes: [{ pattern: "drop.example.com", custom_domain: true }] };
  assert.match(profileMismatch(routed, "public", tracked.migrations) ?? "", /routes/);
  assert.match(profileMismatch({ ...base, preview_urls: true }, "public", tracked.migrations) ?? "", /preview_urls/);
  // A declared required secret would make the first deploy fail before anything is configured.
  for (const secrets of [{ required: CONFIG_SECRETS }, { required: ["ALLOWED_ORIGINS"] }, {}]) {
    assert.match(profileMismatch({ ...base, secrets }, "public", tracked.migrations) ?? "", /secrets/, JSON.stringify(secrets));
  }
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
  assert.match(
    profileMismatch(stripRootOnly(generate("production")), "production", tracked.migrations) ?? "",
    /must not carry/,
  );
});

test("production and staging configs are exactly what they were before the button (b8d8e19)", () => {
  const keys = (config) => Object.keys(config).sort();
  const expected = [
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "durable_objects",
    "main",
    "migrations",
    "name",
    "no_bundle",
    "routes",
    "rules",
    "workers_dev",
  ];
  assert.deepEqual(keys(production()), expected);
  assert.deepEqual(keys(staging("example-staging")), expected.filter((key) => key !== "routes"));
});

test("production keys are written in the order deployed before the button (b8d8e19)", () => {
  assert.deepEqual(Object.keys(inProductionOrder(production())), [
    "compatibility_date",
    "name",
    "compatibility_flags",
    "workers_dev",
    "routes",
    "durable_objects",
    "migrations",
    "main",
    "assets",
    "no_bundle",
    "rules",
  ]);
  assert.deepEqual(Object.keys(inProductionOrder({ z: 1, name: "a" })), ["name", "z"]);
});

test("staging is the public build renamed", () => {
  const config = staging("example-staging");
  assert.equal(profileMismatch(config, "staging", tracked.migrations, "example-staging"), null);
  assert.match(profileMismatch(staging("dropreceive"), "staging", tracked.migrations, "dropreceive") ?? "", /production/);
});

test("a build for one profile is refused as another", () => {
  assert.ok(profileMismatch(publicBuild(), "production", tracked.migrations));
  assert.ok(profileMismatch(production(), "public", tracked.migrations));
  assert.ok(profileMismatch(publicBuild(), "staging", tracked.migrations, PUBLIC_WORKER));
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

test(".dev.vars.example: every secret listed, all commented out (optional), and tracked", () => {
  const text = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
  const active = text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.deepEqual(active, [], "nothing active: no secret is required");
  for (const name of CONFIG_SECRETS) assert.ok(text.includes(`\n# ${name}=\n`), name);
  assert.match(text, /optional/i);
  // eslint-disable-next-line no-control-regex
  assert.equal(/[^\x00-\x7f]/.test(text), false, "ASCII only");
  const root = new URL("..", import.meta.url).pathname;
  assert.throws(() => execFileSync("git", ["check-ignore", "-q", ".dev.vars.example"], { cwd: root }), "must not be gitignored");
});

test("package.json: deploy builds, then checks the public profile; every secret is described as optional", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Builds itself, so the button works even when the dashboard build command is empty.
  assert.equal(pkg.scripts.deploy, "npm run build && node scripts/check-profile.mjs public && wrangler deploy");
  assert.equal(pkg.scripts.build, "vite build");
  // The custom build in wrangler.jsonc must never call back into a deploy script.
  assert.equal(/deploy|wrangler/.test(pkg.scripts.build), false);
  assert.match(pkg.scripts["deploy:production"], /DROP_PROFILE=production .*check-profile\.mjs production && wrangler deploy$/);
  assert.deepEqual(Object.keys(pkg.cloudflare.bindings).sort(), [...CONFIG_SECRETS].sort());
  for (const name of CONFIG_SECRETS) {
    assert.ok(pkg.cloudflare.bindings[name].description.length > 20, name);
    assert.match(pkg.cloudflare.bindings[name].description, /Optional/, name);
  }
});

const STORE_ID = "0123456789abcdef0123456789abcdef";

test("Secrets Store bindings: off unless DROP_SECRETS_STORE_ID is set", () => {
  assert.deepEqual(secretsStoreBindings({}), []);
  assert.deepEqual(secretsStoreBindings({ DROP_SECRETS_STORE_ID: "  " }), []);
  assert.equal("secrets_store_secrets" in profileOverrides("public", {}), false);
  assert.equal("secrets_store_secrets" in profileOverrides("production", {}), false);
  // The default (no env argument) is what the tracked profiles produce: no bindings.
  assert.equal("secrets_store_secrets" in profileOverrides("production"), false);
  assert.equal("secrets_store_secrets" in tracked, false);
});

test("Secrets Store bindings: SS_<KEY> to the DROP_* secret names, cookie name overridable", () => {
  assert.deepEqual(secretsStoreBindings({ DROP_SECRETS_STORE_ID: STORE_ID }), [
    { binding: "SS_GOOGLE_CLIENT_ID", store_id: STORE_ID, secret_name: "DROP_GOOGLE_CLIENT_ID" },
    { binding: "SS_GOOGLE_CLIENT_SECRET", store_id: STORE_ID, secret_name: "DROP_GOOGLE_CLIENT_SECRET" },
    { binding: "SS_MS_CLIENT_ID", store_id: STORE_ID, secret_name: "DROP_MS_CLIENT_ID" },
    { binding: "SS_MS_CLIENT_SECRET", store_id: STORE_ID, secret_name: "DROP_MS_CLIENT_SECRET" },
    { binding: "SS_DRIVE_COOKIE_KEY", store_id: STORE_ID, secret_name: "DROP_DRIVE_COOKIE_KEY" },
  ]);
  const custom = secretsStoreBindings({ DROP_SECRETS_STORE_ID: STORE_ID, DROP_COOKIE_KEY_SECRET_NAME: "DROP_DRIVE_COOKIE_KEY_STAGING" });
  assert.equal(custom.at(-1).secret_name, "DROP_DRIVE_COOKIE_KEY_STAGING");
  assert.throws(() => secretsStoreBindings({ DROP_SECRETS_STORE_ID: "not-an-id" }), /32-character/);
  assert.throws(() => secretsStoreBindings({ DROP_SECRETS_STORE_ID: STORE_ID, DROP_COOKIE_KEY_SECRET_NAME: "a b" }), /without spaces/);
});

test("Secrets Store opt-in builds still pass their profile checks", () => {
  const env = { DROP_SECRETS_STORE_ID: STORE_ID };
  const withStore = (profile) =>
    stripRootOnly(
      mergeLikeNitro(
        { main: "index.mjs", assets: { binding: "ASSETS", directory: "../public" } },
        mergeLikeNitro(profileOverrides(profile, env), tracked),
      ),
    );
  const pub = withStore("public");
  assert.equal(pub.secrets_store_secrets.length, 5);
  assert.equal(profileMismatch(pub, "public", tracked.migrations), null);
  const prod = inProductionOrder(stripPublicOnly(withStore("production")));
  assert.equal(profileMismatch(prod, "production", tracked.migrations), null);
  // Bindings the app does not read are refused.
  const bad = { ...pub, secrets_store_secrets: [{ binding: "SS_OTHER", store_id: STORE_ID, secret_name: "X" }] };
  assert.match(profileMismatch(bad, "public", tracked.migrations), /does not read/);
});
