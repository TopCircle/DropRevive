import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

function appRevision(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig(({ command, isPreview }) => ({
  define: {
    __APP_REVISION__: JSON.stringify(appRevision()),
  },
  server: {
    host: "0.0.0.0",
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
            // the worker name and domain; nitro writes the final config to .output/.
            preset: "cloudflare_module",
            // Nitro v3 defaults serverDir to false; the transfer routes live in server/.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
