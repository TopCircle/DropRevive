import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { en } from "./packs/en.ts";
import { zhMessages } from "./packs/zh.ts";
import { splitPlaceholder } from "./rich.ts";

test("splitPlaceholder cuts the message around each placeholder", () => {
  assert.deepEqual(splitPlaceholder("打开 {setup} 看怎么配置。", "setup"), ["打开 ", " 看怎么配置。"]);
  assert.deepEqual(splitPlaceholder("no placeholder", "setup"), ["no placeholder"]);
  assert.deepEqual(splitPlaceholder("{setup}", "setup"), ["", ""]);
  assert.deepEqual(splitPlaceholder("a {other} b", "setup"), ["a {other} b"]);
});

test("drive off-state texts carry exactly one {setup} link placeholder and no markup", () => {
  for (const messages of [zhMessages, en.messages]) {
    for (const key of ["settings.googleOff", "settings.microsoftOff"] as const) {
      const text = messages[key];
      assert.equal(splitPlaceholder(text, "setup").length, 2, `${key}: ${text}`);
      assert.doesNotMatch(text, /[<>]/, key);
      assert.doesNotMatch(text.replace("{setup}", ""), /\/setup/, `${key} still has a bare /setup`);
    }
  }
});

test("settings dialog renders {setup} as an in-app /setup link", () => {
  const source = readFileSync(new URL("../../components/drop/settings-dialog.tsx", import.meta.url), "utf8");
  assert.match(source, /<SetupLinked text=\{t\("settings\.googleOff"\)\}/);
  assert.match(source, /<SetupLinked text=\{t\("settings\.microsoftOff"\)\}/);
  assert.match(source, /<Link data-setup-link="" to="\/setup"[^>]*className="underline underline-offset-4 hover:text-foreground"/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
