import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TELEGRAM_URL } from "./links.ts";

test("TELEGRAM_URL is the Telegram link in SECURITY.md", () => {
  const text = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");
  const urls = new Set(text.match(/https:\/\/t\.me\/[A-Za-z0-9_]+/g));
  assert.deepEqual([...urls], [TELEGRAM_URL]);
});
