import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { PROFILE_VAR, profileFrom, profileOverrides } from "./scripts/wrangler-profile.mjs";

import pkg from "./package.json" with { type: "json" };

/** Short commit of the build, with -dirty when tracked files have uncommitted changes. */
function appRevision(): string {
  try {
    const rev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim();
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "dev";
  }
}

export default defineConfig(({ command, isPreview }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REVISION__: JSON.stringify(appRevision()),
  },
  server: {
    // localhost only by default; HOST=0.0.0.0 npm run dev exposes it on the LAN.
    host: process.env.HOST || "localhost",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            // Cloudflare Workers (module syntax + static assets). wrangler.jsonc holds
            // the public Worker config; nitro writes the final config to .output/.
            preset: "cloudflare_module",
            // DROP_PROFILE=production (deploy:production) targets the maintainer's Worker and
            // domain; unset builds the public workers.dev profile from wrangler.jsonc.
            // DROP_SECRETS_STORE_ID (optional) adds the Secrets Store bindings SS_<KEY>.
            cloudflare: { wrangler: profileOverrides(profileFrom(process.env[PROFILE_VAR]), process.env) },
            // Nitro v3 defaults serverDir to false; the transfer routes live in server/.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
