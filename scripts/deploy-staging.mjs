#!/usr/bin/env node
/**
 * Deploy the already-built worker to dropreceive-staging on workers.dev.
 * Reads .output/server/wrangler.json and writes a sibling staging file.
 * Never deploys the production name or drop.habor.dpdns.org.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedPath = join(root, ".output/server/wrangler.json");
const stagingPath = join(root, ".output/server/wrangler.staging.json");

const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
const staging = structuredClone(generated);
staging.name = "dropreceive-staging";
delete staging.routes;
staging.workers_dev = true;

const bindings = staging.durable_objects?.bindings;
if (!Array.isArray(bindings) || bindings.length === 0) {
  staging.durable_objects = {
    bindings: [{ name: "SPIKE_ROOM", class_name: "SpikeRoom" }],
  };
  const migrations = Array.isArray(staging.migrations) ? staging.migrations : [];
  if (!migrations.some((migration) => migration?.tag === "v0-spike")) {
    staging.migrations = [
      ...migrations,
      { tag: "v0-spike", new_sqlite_classes: ["SpikeRoom"] },
    ];
  }
}

// ALLOWED_ORIGINS is a Worker secret (wrangler secret put), never written here.
if (!staging.vars) staging.vars = {};
if (existsSync(join(root, "server/routes/api/spike.ts"))) {
  staging.vars.SPIKE = "1";
}

const text = JSON.stringify(staging, null, 2);
if (staging.name === "dropreceive" || text.includes("drop.habor.dpdns.org")) {
  console.error("refusing to write a staging config that still targets production");
  process.exit(1);
}
writeFileSync(stagingPath, text + "\n");

const child = spawn("npx", ["wrangler", "deploy", "--config", stagingPath], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
