import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bumpVersion, cutChangelog, release } from "./release.mjs";

test("bumpVersion follows semver", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => bumpVersion("1.2.3", "huge"));
  assert.throws(() => bumpVersion("1.2", "patch"));
});

test("cutChangelog dates Unreleased and keeps older entries", () => {
  const out = cutChangelog("# Changelog\n\n## [Unreleased]\n\n- fix\n\n## [1.0.0] - 2026-10-13\n\n- first\n", "1.0.1", "2026-11-01");
  assert.equal(out, "# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-11-01\n\n- fix\n\n## [1.0.0] - 2026-10-13\n\n- first\n");
  assert.throws(() => cutChangelog("## [Unreleased]\n\n## [1.0.0]\n", "1.0.1", "x"), /empty/);
});

test("release commits and tags locally in a scratch repo, refusing a dirty tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", packages: { "": { version: "1.0.0" } } }, null, 2) + "\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- new thing\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "stray.txt"), "x");
  assert.throws(() => release("minor", { cwd: dir }), /not clean/);
  git("clean", "-qfd");
  assert.deepEqual(release("minor", { cwd: dir, date: "2026-10-20" }), { version: "1.1.0", tag: "v1.1.0" });
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages[""].version, "1.1.0");
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /## \[1\.1\.0\] - 2026-10-20\n\n- new thing/);
  assert.equal(git("cat-file", "-t", "v1.1.0"), "tag");
  assert.equal(git("log", "-1", "--format=%an <%ae>|%s"), "TopCircle <8945613+TopCircle@users.noreply.github.com>|release: v1.1.0");
  assert.equal(git("remote"), "");
  assert.throws(() => release("minor", { cwd: dir }), /empty/);
});
