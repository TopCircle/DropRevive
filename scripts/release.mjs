#!/usr/bin/env node
// Local release helper: bump the version, date the CHANGELOG, commit and tag. Never pushes or deploys.
// Usage: npm run release -- <patch|minor|major>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const AUTHOR = { name: "TopCircle", email: "8945613+TopCircle@users.noreply.github.com" };

export function bumpVersion(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain semver version: ${version}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`bump must be patch, minor or major (got ${kind})`);
}

/** Moves the "## [Unreleased]" body under a new dated heading and leaves an empty Unreleased. */
export function cutChangelog(text, version, date) {
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");
  const start = head.index + head[0].length;
  const next = text.slice(start).search(/^## \[/m);
  const end = next < 0 ? text.length : start + next;
  const body = text.slice(start, end).trim();
  if (!body) throw new Error("the Unreleased section is empty; add notes before releasing");
  return `${text.slice(0, head.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

export function release(kind, { cwd = process.cwd(), date = new Date().toISOString().slice(0, 10) } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) throw new Error("working tree is not clean");
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("release from main only");
  const pkgPath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = bumpVersion(pkg.version, kind);
  const tag = `v${version}`;
  if (git("tag", "--list", tag)) throw new Error(`tag ${tag} already exists`);
  const logPath = join(cwd, "CHANGELOG.md");
  writeFileSync(logPath, cutChangelog(readFileSync(logPath, "utf8"), version, date));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const files = ["package.json", "CHANGELOG.md"];
  const lockPath = join(cwd, "package-lock.json");
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    files.push("package-lock.json");
  } catch {
    // no lockfile: nothing to bump
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
  };
  const run = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  run("add", ...files);
  run("commit", "-q", "-m", `release: ${tag}`);
  run("tag", "-a", tag, "-m", `DropRevive ${tag}`);
  return { version, tag };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { tag } = release(process.argv[2]);
    console.log(`Created commit and tag ${tag} locally. Nothing was pushed or deployed.`);
    console.log(`Next (each needs approval): git push origin main ${tag}; deploy; move 'production'; gh release create ${tag}`);
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
