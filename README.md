# DropRevive

[中文](README.zh-CN.md)

Send text and files between your own devices. Sign in with your Google Drive or OneDrive; content lives in that drive's `DropRevive` folder. The browser talks to the drive directly. This project's servers only serve the web app — they do not store your files and do not mint share links for other people.

When the other side opens later, sign in with the same drive account and sync to see the same cloud items. When both devices are with you, use temporary LAN transfer so files never go through the drive. There are no multi-user rooms and no anonymous share links.

DropRevive is an independent project for the kind of need Edge Drop used to cover. It is not affiliated with Microsoft Edge, Microsoft, or Google.

Try it live: <https://drop.habor.dpdns.org>

License: [MIT](LICENSE)

## For users

1. Open the site, connect Google Drive or OneDrive in Settings (or both).
2. Write text or add files; they go to the `DropRevive` folder on your drive. Sidebar folders are subfolders of that directory.
3. On another device, open the same drive account and wait for sync.

When both devices are nearby and both have DropRevive open, use temporary LAN transfer. Pair with a QR code or an 8-character code. Files go straight to the other device — not into the `DropRevive` drive folder. If the other side opens later, use the cloud inbox instead.

**Scanning the QR code with a phone.** The in-page scanner uses the browser's `BarcodeDetector` when it exists and falls back to a bundled jsQR decoder (loaded on demand) when it is missing, throws, or stays silent for a few seconds. `BarcodeDetector` can be present yet useless, for example in Android browsers without Google services, which is why the fallback does not depend on it being absent. The camera asks for 1280x720 at 30 fps, switches on continuous autofocus where the browser supports it, offers a torch button when the camera has one, and tap-to-focus where supported. The viewfinder fills the panel width. Problems (permission denied, no camera, a QR from another site, nothing read after 10 seconds) show as short toasts, never as text over the picture. You can always type the 8-character code instead. To see what the scanner is doing on a device, open the site with `?scandebug=1` (see [Contributing](CONTRIBUTING.md)).

Pairing needs access to the site. File bytes do not go through the Worker. There is no LAN auto-discovery and no server relay. If the link fails, switch to cloud. Max 32 MiB per file, 64 MiB per batch, 32 KiB for text. Keep the page in the foreground while transferring. Save each received file with a tap when done.

What works today:

- Send text and files; download, preview, and filter from any connected drive.
- Background sync and manual "Sync now". Incomplete listing does not wipe existing local history.
- Chinese and English; light / dark / system theme; device name.
- Install as a PWA. The installed icon and the browser tab icon are two different assets.
- Offline viewing of items already synced on this device.
- A Telegram icon next to Settings (and a link on the privacy page) opens the project's Telegram group.

New content while offline is not queued. Drops fail immediately and are not written to local history. Deletes likewise need the network. Clearing local cache leaves cloud files on the drive; deleting an item in the app removes the matching drive files.

### Scopes actually granted when you connect

Each connect button in Settings has a short note above it.

| Drive | Scope on the consent screen | How the app uses it |
| --- | --- | --- |
| Google Drive | `drive.file` | Only files this app created or opened — i.e. the `DropRevive` folder |
| OneDrive | `Files.ReadWrite`, plus `User.Read` and `offline_access` | Consent covers the whole OneDrive. The app only reads/writes the `DropRevive` folder and keeps you signed in |

OneDrive has no narrower scope that preserves the current behavior. `Files.ReadWrite.AppFolder` only reaches the app's special folder, not a same-named folder at the drive root. `Files.ReadWrite.Selected` makes the user pick files one by one, so the app cannot create folders and sync on its own. The OneDrive consent screen therefore still asks for full drive read/write.

### What is stored on this device

| Place | Key / store | Contents |
| --- | --- | --- |
| IndexedDB `droprevive` | `items`, `blobs`, `kv` | History cache, file cache, and the seal key below |
| localStorage | `droprevive.settings` | Theme, device name |
| localStorage | `droprevive.folders`, `droprevive.shelves` | Drive folder IDs, sidebar folders |
| localStorage | `droprevive.locale` | UI language; same-named cookie for the offline page |
| localStorage | `droprevive.tokens` | Sealed access tokens so "connected" survives a refresh. Refresh tokens are not here |
| localStorage | `droprevive.outbox` | Cloud refs still to replay on sync. Live deletes no longer append here; failed deletes stay in history |
| Cookie | `__Secure-dr-g`, `__Secure-dr-m` | Encrypted refresh tokens, HttpOnly, sent only to `/api/drive-auth` |

`droprevive.tokens` is sealed with AES-GCM before localStorage; the key lives in same-origin IndexedDB and is non-exportable. These are access tokens (~1 hour). Refresh tokens live only in the HttpOnly cookie; page scripts cannot read them. Scripts that can run on this origin — including XSS if it ever appears — can still unwrap and use the access token and ask the Worker to refresh. This layer blocks casual localStorage inspection, not same-origin scripts.

If UI language was never saved: browser languages starting with `zh` get Chinese, `en` get English, anything else Chinese.

## For people who self-host

`npm run deploy` is the self-host command. `npm run deploy:production` is reserved for maintainers; it bakes in the production site's public client IDs and deploys to the domain in `wrangler.jsonc`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local dev at <http://localhost:8080>. Without client IDs in the environment, drives show as unavailable |
| `npm run build` | Production build into `.output/` using the current env vars |
| `npm run deploy` | Deploy to your Cloudflare account. Checks `wrangler.jsonc` first and refuses, before building, while the Worker is named `dropreceive`, a route points at `drop.habor.dpdns.org`, or no route is set |
| `npm run deploy:production` | Maintainers only. Replaces production Worker `dropreceive` |

To self-host with sign-in:

1. Change `wrangler.jsonc` `routes` to your domain and rename the Worker from `dropreceive` to your own name (e.g. `my-droprevive`); keep `workers_dev` false. `npm run deploy` refuses until both are changed.
2. Create a web OAuth client in Google Cloud. Callback: `https://YOUR_DOMAIN/api/drive-auth/google/callback`. Scope `drive.file`. Consent screen needs offline access so a refresh token is issued.
3. Register a Web platform app in Azure (not SPA). Callback: `https://YOUR_DOMAIN/api/drive-auth/microsoft/callback`. Scopes `User.Read`, `Files.ReadWrite`, `offline_access`. Authority `common`. Create a client secret for the app.
4. Set your own `VITE_GOOGLE_CLIENT_ID` and `VITE_MS_CLIENT_ID` before build/deploy. Either may be empty: the site loads; that drive shows as unavailable. These are public client IDs (build-time env), not Worker secrets.
5. Set Worker secrets with `npx wrangler secret put <NAME> --name <worker>` (stdin; never write values into files or `wrangler.jsonc` `vars`):

   | Secret | Purpose | Format / example |
   | --- | --- | --- |
   | `ALLOWED_ORIGINS` | Origins allowed for drive sign-in and LAN pairing | Comma-separated full origins, e.g. `https://YOUR_DOMAIN` (no path). Missing or empty → refuse deployed hosts (fail closed). `http://localhost:8080` is always allowed for local `npm run dev` only. |
   | `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | From Google Cloud console |
   | `MS_CLIENT_SECRET` | Microsoft OAuth client secret | From Azure app registration |
   | `DRIVE_COOKIE_KEY` | AES-GCM key for refresh-token cookies | 32 random bytes, base64 (e.g. `openssl rand -base64 32`) |

   Example: `printf '%s' 'https://YOUR_DOMAIN' | npx wrangler secret put ALLOWED_ORIGINS --name my-droprevive`
6. `npx wrangler login` to your Cloudflare account, then `npm run deploy`.

For real sign-in locally, register `http://localhost:8080/api/drive-auth/google/callback` and `http://localhost:8080/api/drive-auth/microsoft/callback` in both consoles, then run `npm run dev` with both client IDs and the three OAuth/cookie secrets. `ALLOWED_ORIGINS` is optional locally (`http://localhost:8080` is built in). `127.0.0.1:8081` is not an allowed origin.

Maintainer client IDs are registered only for `https://drop.habor.dpdns.org`. They will not complete sign-in on another domain.

## Development

- [Contributing](CONTRIBUTING.md) · [Architecture](docs/architecture.md) ([中文](docs/architecture.zh-CN.md)) · [Security policy](SECURITY.md)
- GitHub Actions runs typecheck, tests, lint and build on pushes and pull requests. CI does not use deployment secrets.
- `npm test` runs the script tests and then the unit and integration tests: the transfer protocol and LAN rooms, the scanner helpers, the drive-auth broker, cross-tab token renewal, and the drive store (sync, delete, token expiry). At the time of writing that is 10 script tests plus 264 others; lint is kept at 0 errors and 0 warnings.
- Community and questions: the project's Telegram group, <https://t.me/droprevive>. Report security problems privately, see [SECURITY.md](SECURITY.md).
- `npm run deploy` runs the guarded self-host deployment. `npm run deploy:production` is the explicit maintainer-only production command for `drop.habor.dpdns.org`.

Notes:

- Copy lives in `src/lib/i18n/`. The Chinese pack defines the keys; every other pack must cover the same keys and be added with `registerPack` in `src/lib/i18n/index.ts`.
- `wrangler.jsonc` sets `compatibility_date` `2026-09-26` with `nodejs_compat`, and omits `main` / `assets`: the build writes the final config to `.output/server/wrangler.json`.
- Each production deploy is tagged `production`; the tag marks the source that is live.
- The PWA manifest is the static `public/manifest.webmanifest` (icons in `public/icons/`, share target `/share`); `public/sw.js` is the Service Worker. There is no account system or database.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
npm run deploy          # self-host; refuses while the maintainer domain is configured
npm run deploy:production # updates https://drop.habor.dpdns.org only
npm run deploy:staging  # maintainers: updates the private test-site Worker only (its address is not public)
```
