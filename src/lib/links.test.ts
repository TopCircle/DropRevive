import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TELEGRAM_URL } from "./links.ts";

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
