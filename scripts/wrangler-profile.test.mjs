import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripJsonc } from "./deploy-self.mjs";
import {
  PRODUCTION_HOST,
  PRODUCTION_WORKER,
  PUBLIC_WORKER,
  mergeLikeNitro,
  profileFrom,
  profileMismatch,
  profileOverrides,
} from "./wrangler-profile.mjs";

const tracked = JSON.parse(stripJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
/** What nitro writes to .output/server/wrangler.json (main/assets added by nitro). */
const generate = (profile) =>
  mergeLikeNitro({ main: "index.mjs", assets: { directory: "../public" } }, mergeLikeNitro(profileOverrides(profile), tracked));

/** deploy-staging.mjs: the public build renamed. */
function staging(name) {
  const config = structuredClone(generate("public"));
  config.name = name;
  delete config.routes;
  delete config.route;
  config.workers_dev = true;
  return config;
}

test("tracked wrangler.jsonc is the public profile: droprevive on workers.dev, no route", () => {
  assert.equal(tracked.name, PUBLIC_WORKER);
  assert.equal(tracked.workers_dev, true);
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

test("public profile generates a workers.dev config", () => {
  const config = generate("public");
  assert.equal(profileMismatch(config, "public", tracked.migrations), null);
  assert.equal(config.name, PUBLIC_WORKER);
});

test("production profile generates dropreceive + custom domain + identical migrations", () => {
  const config = generate("production");
  assert.equal(config.name, PRODUCTION_WORKER);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [{ pattern: PRODUCTION_HOST, custom_domain: true }]);
  assert.deepEqual(config.migrations, tracked.migrations);
  assert.deepEqual(config.durable_objects, tracked.durable_objects);
  assert.equal(profileMismatch(config, "production", tracked.migrations), null);
});

test("staging is the public build renamed", () => {
  const config = staging("dropreceive-staging");
  assert.equal(profileMismatch(config, "staging", tracked.migrations, "dropreceive-staging"), null);
  assert.match(profileMismatch(staging("dropreceive"), "staging", tracked.migrations, "dropreceive") ?? "", /production/);
});

test("a build for one profile is refused as another", () => {
  assert.ok(profileMismatch(generate("public"), "production", tracked.migrations));
  assert.ok(profileMismatch(generate("production"), "public", tracked.migrations));
  const lost = { ...generate("production"), migrations: [] };
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
