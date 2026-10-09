import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

type Icon = { src: string; sizes: string; type: string };
type Manifest = {
  name: string;
  id: string;
  start_url: string;
  display: string;
  icons: Icon[];
  share_target: {
    action: string;
    method: string;
    enctype: string;
    params: {
      title: string;
      text: string;
      url: string;
      files: { name: string; accept: string[] }[];
    };
  };
};

test("public/manifest.webmanifest exists and parses", () => {
  assert.ok(existsSync(new URL("public/manifest.webmanifest", root)));
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as Manifest;
  assert.equal(manifest.name, "DropRevive");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
});

test("manifest keeps the system share target pointing at /share", () => {
  const { share_target: share } = JSON.parse(read("public/manifest.webmanifest")) as Manifest;
  assert.equal(share.action, "/share");
  assert.equal(share.method, "POST");
  assert.equal(share.enctype, "multipart/form-data");
  assert.deepEqual(
    [share.params.title, share.params.text, share.params.url],
    ["title", "text", "url"],
  );
  assert.equal(share.params.files[0]?.name, "media");
});

test("every manifest icon exists under public/ and 192/512 are present", () => {
  const { icons } = JSON.parse(read("public/manifest.webmanifest")) as Manifest;
  assert.ok(icons.length > 0);
  for (const icon of icons) {
    assert.match(icon.src, /^\/icons\//, icon.src);
    assert.ok(existsSync(new URL(`public${icon.src}`, root)), `${icon.src} is missing`);
  }
  const sizes = icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"));
  assert.ok(sizes.includes("512x512"));
});

test("the document head links the static manifest and the touch icon, with no platform paths", () => {
  const rootRoute = read("src/routes/__root.tsx");
  assert.match(rootRoute, /href: "\/manifest\.webmanifest"/);
  assert.match(rootRoute, /href: "\/icons\/icon-180\.png"/);
  assert.ok(existsSync(new URL("public/icons/icon-180.png", root)));
  assert.doesNotMatch(rootRoute, /__grok|og:image/);
});
