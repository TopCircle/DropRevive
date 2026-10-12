#!/usr/bin/env node
/**
 * Deploy this app to the deployer's own Cloudflare account.
 *
 * `npm run deploy:production` is the maintainer command for drop.habor.dpdns.org.
 * `npm run deploy` builds, checks the public profile and runs `wrangler deploy` (what the Deploy
 * to Cloudflare button runs). This command (`npm run deploy:self`)
 * checks wrangler.jsonc, then builds and deploys. It refuses to run while the config
 * could still replace the maintainer's Worker: the Worker is named `dropreceive`, or a
 * route or custom domain points into the maintainer's zone. A workers.dev-only Worker
 * (`workers_dev: true`, no routes) is fine, and so is your own route or custom domain.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripRootOnly } from "./wrangler-profile.mjs";

export const MAINTAINER_HOST = "drop.habor.dpdns.org";
/** Any route in the maintainer's zone counts, not only the exact host. */
export const MAINTAINER_ZONE = "habor.dpdns.org";
export const MAINTAINER_WORKER = "dropreceive";

/**
 * JSONC to JSON: drops line and block comments outside strings, so a glob string such as the
 * ESModule rule in wrangler.jsonc is not mistaken for a comment.
 * @param {string} text
 */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += char;
  }
  return out;
}

/**
 * Every route wrangler accepts: `routes` as strings or objects (`{ pattern }`, with or
 * without `custom_domain` / `zone_name`), and the singular `route` as a string or
 * object. An entry without a readable pattern becomes "" so the guard can refuse it.
 */
export function routePatterns(text) {
  const parsed = JSON.parse(stripJsonc(text));
  const entries = [];
  if (Array.isArray(parsed.routes)) entries.push(...parsed.routes);
  else if (parsed.routes !== undefined) entries.push(parsed.routes);
  if (parsed.route !== undefined) entries.push(parsed.route);
  return entries.map((route) => {
    if (typeof route === "string") return route.trim();
    if (route && typeof route === "object" && typeof route.pattern === "string")
      return route.pattern.trim();
    return "";
  });
}

export function usesMaintainerRoute(text) {
  return routePatterns(text).some((pattern) => pattern.toLowerCase().includes(MAINTAINER_ZONE));
}

/** Why this config must not be deployed with the self-host command, or null when it is fine. */
export function refusalReason(text) {
  let parsed;
  let patterns;
  try {
    parsed = JSON.parse(stripJsonc(text));
    patterns = routePatterns(text);
  } catch {
    return "wrangler.jsonc could not be read.";
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) return 'wrangler.jsonc has no Worker name. Set your own, e.g. "my-droprevive".';
  if (name === MAINTAINER_WORKER) {
    return `the Worker is still named "${MAINTAINER_WORKER}", the maintainer's production Worker. Rename it, e.g. "my-droprevive".`;
  }
  if (patterns.length === 0 && parsed.workers_dev !== true)
    return 'no route or custom domain is configured and workers_dev is not true. Set "workers_dev": true or point routes at your own domain.';
  if (patterns.some((pattern) => !pattern)) return "a route in wrangler.jsonc has no pattern.";
  if (usesMaintainerRoute(text))
    return `routes still point at ${MAINTAINER_HOST}. Change them to your own domain.`;
  return null;
}

/** Whether a .dev.vars text sets at least one KEY=value (comments and blank values do not count). */
export function hasActiveVars(text) {
  return text.split(/\r?\n/).some((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(line) && !/^\s*#/.test(line));
}

/** The command the user typed, for the refusal message. */
export function commandName(event = process.env.npm_lifecycle_event) {
  return event === "deploy:self"
    ? `npm run ${event}`
    : "node scripts/deploy-self.mjs";
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const reason = refusalReason(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  if (reason) {
    const command = commandName();
    console.error(`${command} refused (nothing was built or deployed): ${reason}`);
    console.error(
      `${command} 已拒绝执行（没有构建，也没有部署）。wrangler.jsonc 仍可能覆盖维护者的线上 Worker：请改用你自己的 Worker 名和域名。`,
    );
    console.error(
      "Maintainers update the production site with npm run deploy:production. 维护者更新正式站用 npm run deploy:production。",
    );
    process.exit(1);
  }
  await run("npm", ["run", "build"], root);
  // Drop wrangler.jsonc's custom build from the generated config, or `wrangler deploy` builds again.
  const generatedPath = join(root, ".output/server/wrangler.json");
  writeFileSync(generatedPath, JSON.stringify(stripRootOnly(JSON.parse(readFileSync(generatedPath, "utf8"))), null, 2));
  // Every secret is optional. If .dev.vars (from .dev.vars.example) sets any, upload them with the Worker.
  const secretsFile = join(root, ".dev.vars");
  const upload = existsSync(secretsFile) && hasActiveVars(readFileSync(secretsFile, "utf8"));
  await run("wrangler", upload ? ["deploy", "--secrets-file", secretsFile] : ["deploy"], root);
}
