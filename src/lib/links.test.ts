import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GITHUB_URL, TELEGRAM_URL } from "./links.ts";

test("TELEGRAM_URL is the Telegram link in SECURITY.md", () => {
  const text = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");
  const urls = new Set(text.match(/https:\/\/t\.me\/[A-Za-z0-9_]+/g));
  assert.deepEqual([...urls], [TELEGRAM_URL]);
});

test("first-deploy workers.dev note is in the docs, both READMEs and /setup", () => {
  for (const file of ["README.md", "README.zh-CN.md", "docs/self-host.md", "docs/self-host.zh-CN.md", "src/routes/setup.tsx"]) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(text, /Domains (&|&amp;) Routes/, file);
    assert.match(text, /workers\.dev/, file);
  }
  const setup = readFileSync(new URL("../routes/setup.tsx", import.meta.url), "utf8");
  assert.match(setup, /data-testid="setup-workers-dev"[\s\S]*?打开[\s\S]*?turn on workers\.dev/);
});

test("GITHUB_URL is the repository homepage", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(GITHUB_URL, "https://github.com/TopCircle/DropRevive");
  assert.equal(pkg.homepage, `${GITHUB_URL}#readme`);
  assert.equal(pkg.repository.url, `git+${GITHUB_URL}.git`);
});

test("desktop and mobile toolbars link to GitHub next to Telegram; the privacy page does not", () => {
  const desktop = readFileSync(new URL("../components/drop/desktop-shell.tsx", import.meta.url), "utf8");
  const mobile = readFileSync(new URL("../components/drop/drop-app.tsx", import.meta.url), "utf8");
  const privacy = readFileSync(new URL("../routes/privacy.tsx", import.meta.url), "utf8");
  for (const [name, source] of [
    ["desktop-shell", desktop],
    ["drop-app", mobile],
  ] as const) {
    assert.match(source, /GitHubIcon/, name);
    const telegramHref = source.lastIndexOf("href={TELEGRAM_URL}");
    const githubHref = source.lastIndexOf("href={GITHUB_URL}");
    assert.ok(telegramHref >= 0 && githubHref > telegramHref, `${name}: GitHub link should follow Telegram`);
    const around = source.slice(githubHref, githubHref + 160);
    assert.match(around, /target="_blank"/, name);
    assert.match(around, /rel="noopener noreferrer"/, name);
    assert.match(around, /aria-label=\{t\("nav\.github"\)\}/, name);
    assert.match(around, /title=\{t\("nav\.github"\)\}/, name);
  }
  assert.doesNotMatch(privacy, /GITHUB_URL|GitHubIcon/);
  assert.match(privacy, /TELEGRAM_URL/);
});
