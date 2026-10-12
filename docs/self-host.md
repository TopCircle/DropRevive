# Self-hosting DropRevive

[中文](self-host.zh-CN.md) · [README](../README.md)

You get your own DropRevive on your own Cloudflare account, signing in to Google Drive and/or OneDrive with OAuth apps you own. Cloudflare's free plan is enough. Plan on 20–30 minutes, most of it in the Google and Azure consoles.

**Overview**

1. [Deploy](#1-deploy) with the button (about 2 minutes).
2. Open `/setup` on your new site and copy the callback URLs.
3. Create the [Google](#google) and/or [OneDrive (Azure)](#onedrive) app.
4. Generate the [cookie key](#cookie-key) and set [allowed origins](#allowed-origins).
5. [Enter the six values](#5-enter-the-values) in Cloudflare, reload `/setup` until it says Ready.

Only one drive? Skip that drive's section and enter `none` for its two values. The other drive shows as unavailable in the app.

## 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TopCircle/DropRevive)

1. Sign in to Cloudflare and connect your GitHub (or GitLab) account when asked.
2. Keep or change the repository name and the Worker name (default `droprevive`).
3. The form should list six secrets (from `.dev.vars.example`, described in `package.json`). Each one is required. If you do not have a value yet, enter `none`; you will set the real values in step 5. Two you can fill in right away: `DRIVE_COOKIE_KEY` ([generate it](#cookie-key)) and `ALLOWED_ORIGINS` = `https://<worker-name>.<your-subdomain>.workers.dev`. Build command `npm run build` and deploy command `npm run deploy` should be filled in for you. If the build fields are empty (deploy command `npx wrangler deploy`), leave them: `wrangler.jsonc` makes a bare `wrangler deploy` build the site first.
4. Deploy. Cloudflare creates the repository in your account, builds it, creates the two Durable Objects (LAN transfer rooms and rate limits) and deploys.

**If the form did not ask for the secrets**, or the build log says `The following required secrets have not been set`: open Workers & Pages → your Worker → **Settings → Variables and Secrets**, add all six as type **Secret** (`none` for an unused drive), then **Deployments → Retry build** (or push any commit). `wrangler.jsonc` declares them in `secrets.required`, so a deploy refuses to go out while any is missing instead of shipping a site that cannot sign in.

Your site is `https://<worker-name>.<your-subdomain>.workers.dev` (the subdomain is shown under Workers & Pages in the dashboard). Every push to your copy of the repository redeploys; secrets are kept.

Without the button: clone the repository, `npm ci`, `npx wrangler login`, copy `.dev.vars.example` to `.dev.vars` and fill it in, then `npm run deploy:self` (it uploads `.dev.vars` as the Worker's secrets with `wrangler deploy --secrets-file`).

## 2. Open /setup

Open `https://<your-site>/setup`. It shows, for each of the six values, whether it is set (never a secret's value), whether the cookie key is valid, whether this origin is in `ALLOWED_ORIGINS`, and the two callback URLs:

- Google: `https://<your-site>/api/drive-auth/google/callback`
- Azure: `https://<your-site>/api/drive-auth/microsoft/callback`

## Google

Gives you `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

1. Open <https://console.cloud.google.com/>, create a project (any name).
2. **APIs & Services → Library**, search **Google Drive API**, **Enable**.
3. **Google Auth Platform** (OAuth consent screen):
   - **Branding**: app name (e.g. "My DropRevive"), support email, developer contact email.
   - **Audience**: User type **External**.
   - **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/drive.file` only. It is a non-sensitive scope: the app only sees files it created.
4. **Clients → Create client**, type **Web application**:
   - **Authorized JavaScript origins**: `https://<your-site>`
   - **Authorized redirect URIs**: the Google callback from `/setup`, exactly.
   - Create, then copy the **Client ID** (`….apps.googleusercontent.com`) → `GOOGLE_CLIENT_ID`, and the **Client secret** → `GOOGLE_CLIENT_SECRET`. Newer consoles show the secret only once; keep it.
5. **Audience → Publish app** so the status is **In production**. While the app is in **Testing**, only listed test users can sign in and sign-in expires after about 7 days.

## OneDrive

Gives you `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. Works with personal Microsoft accounts and work/school accounts.

1. Open <https://portal.azure.com/> → **Microsoft Entra ID → App registrations → New registration**.
   - Name: anything.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: platform **Web** (not SPA), the Azure callback from `/setup`.
2. **Overview**: copy **Application (client) ID** → `MS_CLIENT_ID`.
3. **Certificates & secrets → Client secrets → New client secret**. Choose an expiry (24 months at most). Copy the **Value** (not the Secret ID) → `MS_CLIENT_SECRET`. It is shown only once.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: `Files.ReadWrite`, `User.Read`, `offline_access`. Admin consent is not needed for personal accounts; a work/school tenant may require it.

## Cookie key

`DRIVE_COOKIE_KEY` encrypts the refresh-token cookies. It must be 32 random bytes, base64. Generate it once and keep it secret:

```bash
openssl rand -base64 32
```

Or in any browser's developer console:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

`/setup` checks that it decodes to exactly 32 bytes without showing it. Changing it later signs every device out of the drives (they reconnect once).

## Allowed origins

`ALLOWED_ORIGINS` lists the addresses this Worker serves sign-in and LAN pairing for: full origins, comma-separated, no path or trailing slash. Example:

```
https://droprevive.you.workers.dev,https://drop.example.com
```

When it is missing, sign-in and pairing are refused on every deployed address (fail closed). `/setup` tells you whether the address you opened it on is listed.

## 5. Enter the values

Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Variables and Secrets**. Edit each of the six (type **Secret**), then **Deploy** / save. It takes effect immediately; no rebuild. Or from a terminal:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --name droprevive
```

Reload `/setup`. When it says **Ready**, open the site, Settings, and connect your drive.

| Secret | From | Only one drive? |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google client | `none` if no Google |
| `GOOGLE_CLIENT_SECRET` | Google client | `none` if no Google |
| `MS_CLIENT_ID` | Azure app overview | `none` if no OneDrive |
| `MS_CLIENT_SECRET` | Azure client secret Value | `none` if no OneDrive |
| `DRIVE_COOKIE_KEY` | [generated](#cookie-key) | required |
| `ALLOWED_ORIGINS` | your site address(es) | required |

## Your own domain

1. The domain's zone must be on your Cloudflare account. Worker → **Settings → Domains & Routes → Add → Custom domain**, e.g. `drop.example.com`.
2. Add `https://drop.example.com` to `ALLOWED_ORIGINS` (keep the workers.dev origin too if you still use it).
3. Add the new callback URLs (open `/setup` on the new domain to copy them) to the Google client (plus the JavaScript origin) and to the Azure app.
4. Optional: to keep the domain and turn off workers.dev for good, edit `wrangler.jsonc` in your copy (`"workers_dev": false` and `"routes": [{ "pattern": "drop.example.com", "custom_domain": true }]`) and push. Otherwise the next build re-enables workers.dev as the file says.

## Keeping it running

- **Azure client secret expires** (24 months at most). Put a reminder a month before. Create a new secret, update `MS_CLIENT_SECRET`, then delete the old one. Users stay signed in.
- **Google client secret**: rotate the same way if it leaks (Clients → your client → add secret).
- **Updates**: your repository is a copy, not a fork. To pick up changes: `git remote add upstream https://github.com/TopCircle/DropRevive && git pull upstream main && git push`. The push redeploys.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Drive shows "unavailable" | That drive's client ID is missing; see `/setup` |
| `redirect_uri_mismatch` (Google) or `AADSTS50011` (Azure) | The callback URL in the console differs from the one `/setup` shows (scheme, domain, path) |
| `origin_not_allowed` / sign-in or pairing refused | Add this origin to `ALLOWED_ORIGINS` |
| Google sign-in lapses after a week | Consent screen still in Testing; publish it |
| Signed out on every device | `DRIVE_COOKIE_KEY` was changed, or a client secret expired |
| Build log: `Missing entry-point to Worker script or to assets directory` | The site was not built before `wrangler deploy` (a copy made from an older version of the repository). Workers & Pages → your Worker → **Settings → Build**: set **Deploy command** to `npm run deploy` (it builds, checks and deploys; **Build command** can stay empty or be `npm run build`), save, then **Deployments → Retry build** |
