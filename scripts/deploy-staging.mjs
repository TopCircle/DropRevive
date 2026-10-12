#!/usr/bin/env node
/**
 * Deploy the already-built worker to a maintainer's staging Worker on workers.dev.
 * The Worker name comes from the STAGING_WORKER environment variable, so no staging
 * address is written into the repository:
 *
 *   STAGING_WORKER=<your-staging-worker> npm run deploy:staging
 *
 * Reads .output/server/wrangler.json (a public-profile build) and writes a sibling staging file.
 * Never deploys the production Worker name or the production domain.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "./deploy-self.mjs";
import {
  PRODUCTION_HOST,
  PRODUCTION_WORKER,
  profileMismatch,
  stripPublicOnly,
  stripRootOnly,
} from "./wrangler-profile.mjs";

const name = (process.env.STAGING_WORKER ?? "").trim();
if (!name) {
  console.error(
    "deploy:staging refused: set STAGING_WORKER to your staging Worker name, e.g. STAGING_WORKER=my-staging npm run deploy:staging",
  );
  console.error("deploy:staging 已拒绝：请用环境变量 STAGING_WORKER 指定测试站 Worker 名。");
  process.exit(1);
}
if (name === PRODUCTION_WORKER) {
  console.error(`deploy:staging refused: STAGING_WORKER must not be the production Worker "${PRODUCTION_WORKER}".`);
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedPath = join(root, ".output/server/wrangler.json");
const stagingPath = join(root, ".output/server/wrangler.staging.json");

const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
// Without the public-only key (preview_urls) and the custom build: staging deploys as before.
const staging = stripRootOnly(stripPublicOnly(structuredClone(generated)));
staging.name = name;
delete staging.routes;
delete staging.route;
staging.workers_dev = true;

// ALLOWED_ORIGINS is a Worker secret (wrangler secret put), never written here.
const text = JSON.stringify(staging, null, 2);
if (staging.name === PRODUCTION_WORKER || text.includes(PRODUCTION_HOST)) {
  console.error("refusing to write a staging config that still targets production");
  process.exit(1);
}
const tracked = JSON.parse(stripJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
const problem = profileMismatch(staging, "staging", tracked.migrations, name);
if (problem) {
  console.error(`deploy:staging refused (nothing deployed): ${problem}`);
  process.exit(1);
}
writeFileSync(stagingPath, text + "\n");

const child = spawn("npx", ["wrangler", "deploy", "--config", stagingPath], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
