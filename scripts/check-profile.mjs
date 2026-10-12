#!/usr/bin/env node
/**
 * Refuse to deploy a build whose generated wrangler config does not match the profile:
 *   node scripts/check-profile.mjs production|public [config path]
 * `npm run deploy` (what the Deploy to Cloudflare button runs) checks `public`; deploy:production
 * checks `production`. It first drops wrangler.jsonc's custom build (`build`) from the generated
 * file, so the `wrangler deploy` that follows does not build again; for production it also drops the
 * public-only keys (preview_urls, secrets.required), so production deploys exactly what it did before.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "./deploy-self.mjs";
import {
  inProductionOrder,
  profileMismatch,
  stripPublicOnly,
  stripRootOnly,
} from "./wrangler-profile.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = process.argv[2];
if (profile !== "production" && profile !== "public") {
  console.error("usage: node scripts/check-profile.mjs production|public [config]");
  process.exit(2);
}
const path = process.argv[3] ?? join(root, ".output/server/wrangler.json");
let generated = stripRootOnly(JSON.parse(readFileSync(path, "utf8")));
if (profile === "production") generated = inProductionOrder(stripPublicOnly(generated));
writeFileSync(path, JSON.stringify(generated, null, 2));
const tracked = JSON.parse(stripJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
const problem = profileMismatch(generated, profile, tracked.migrations);
if (problem) {
  console.error(`check-profile ${profile} refused (nothing deployed): ${problem}`);
  console.error(`check-profile ${profile} 已拒绝（没有部署）：生成的配置和预期不符。`);
  process.exit(1);
}
console.log(`check-profile ${profile}: ${generated.name} ok`);
