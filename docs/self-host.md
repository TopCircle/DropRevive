# Self-hosting DropRevive

[中文](self-host.zh-CN.md) · [README](../README.md)

You get your own DropRevive on your own Cloudflare account, signing in to Google Drive and/or OneDrive with OAuth apps you own. Cloudflare's free plan is enough. Plan on 20–30 minutes, most of it in the Google and Azure consoles.

**Deploy first, configure later.** The deploy needs no secrets: right after it the site works and P2P Transfer works. Drives turn on as you add their values.

1. [Deploy](#1-deploy) with the button (about 2 minutes). Nothing to fill in.
2. Open `/setup` on your new site and copy the callback URLs.
3. Create the [Google](#google) and/or [OneDrive (Azure)](#onedrive) app.
4. Generate the [cookie key](#cookie-key).
5. [Enter the values](#5-enter-the-values) in Cloudflare and reload `/setup`. No rebuild.

Every value is optional. A drive is on once its client ID, its client secret and `DRIVE_COOKIE_KEY` are set; until then the app shows it as not configured. Only one drive? Skip the other one's section and leave its two values unset (or `none`). `ALLOWED_ORIGINS` is optional too: unset means only the site's own address is allowed, which covers the workers.dev address and any custom domain.

## 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TopCircle/DropRevive)

1. Sign in to Cloudflare and connect your GitHub (or GitLab) account when asked.
2. Keep or change the repository name and the Worker name (default `droprevive`).
3. Leave the build settings as they are. If the build fields are empty (deploy command `npx wrangler deploy`), that is fine: `wrangler.jsonc` makes a bare `wrangler deploy` build the site first. No secrets are asked for; you add them after the deploy.
4. Deploy. Cloudflare creates the repository in your account, builds it, creates the two Durable Objects (P2P Transfer rooms and rate limits) and deploys.

Your site is `https://<worker-name>.<your-subdomain>.workers.dev` (the subdomain is shown under Workers & Pages in the dashboard). Every push to your copy of the repository redeploys; secrets are kept.

If the `workers.dev` address does not open after the first one-click deploy, go to Workers & Pages → your Worker → **Settings → Domains & Routes** and turn on **workers.dev**. Cloudflare's button flow can leave it off on the first deploy even though the deploy enabled it; later deploys keep it on.

Without the button: clone the repository, `npm ci`, `npx wrangler login`, then `npm run deploy:self`. Optionally copy `.dev.vars.example` to `.dev.vars` and uncomment what you already have; it is uploaded as the Worker's secrets (`wrangler deploy --secrets-file`).

## 2. Open /setup

Open `https://<your-site>/setup`. It shows which drives are on, and for each of the six values whether it is set (never a secret's value; unset shows as "not set (optional)"), whether the cookie key is valid, how `ALLOWED_ORIGINS` applies to this address, and the two callback URLs:

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

Both drives need it: without a valid key (unset, `none`, or not 32 bytes) both stay off; P2P Transfer is not affected. `/setup` checks that it decodes to exactly 32 bytes without showing it. Changing it later signs every device out of the drives (they reconnect once).

## Allowed origins

Optional. **Unset (or `none`)**: same-origin only. A page may use sign-in and P2P pairing only on the address it was loaded from, so the workers.dev address and any custom domain work with nothing configured. `/setup` shows "not set: same-origin only (current: <origin>)".

**Set**: `ALLOWED_ORIGINS` becomes a strict list of the addresses this Worker serves sign-in and P2P pairing for: full origins, comma-separated, no path or trailing slash. Any address not listed is refused, including the one you are on. Example:

```
https://droprevive.you.workers.dev,https://drop.example.com
```

If every entry is malformed (e.g. `drop.example.com` without `https://`), nothing is allowed. This fails closed on purpose so a typo cannot silently widen access. `/setup` flags it; fix the entries or delete the variable.

## 5. Enter the values

Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Variables and Secrets** → **Add**, type **Secret**, then **Deploy** / save. Add only what you use. It takes effect immediately; no rebuild. Or from a terminal:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --name droprevive
```

Reload `/setup`. When it lists a drive as on, open the site, Settings, and connect it.

| Secret | From | Needed for |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google client | Google Drive (unset or `none` = Google off) |
| `GOOGLE_CLIENT_SECRET` | Google client | Google Drive |
| `MS_CLIENT_ID` | Azure app overview | OneDrive (unset or `none` = OneDrive off) |
| `MS_CLIENT_SECRET` | Azure client secret Value | OneDrive |
| `DRIVE_COOKIE_KEY` | [generated](#cookie-key) | both drives |
| `ALLOWED_ORIGINS` | your site address(es) | optional: only to allow other origins ([details](#allowed-origins)) |

### Optional: Cloudflare Secrets Store

To share the drive values between several Workers **in one Cloudflare account** (for example a site and its staging copy), keep them in [Secrets Store](https://developers.cloudflare.com/secrets-store/) (open beta: one store per account) instead of on each Worker. Off by default; the button deploy never needs it.

1. Dashboard → **Secrets Store** → create the store if there is none, and copy its ID.
2. Create these secrets with permission scope **Workers** (create them before step 3; a deploy that binds a missing secret can fail): `DROP_GOOGLE_CLIENT_ID`, `DROP_GOOGLE_CLIENT_SECRET`, `DROP_MS_CLIENT_ID`, `DROP_MS_CLIENT_SECRET`, `DROP_DRIVE_COOKIE_KEY`. Skip a drive you do not use.
3. Worker → **Settings → Build → Variables and secrets** (build variables, not the Worker's runtime ones): add `DROP_SECRETS_STORE_ID` = the store ID. To give a Worker its own cookie key, also set `DROP_COOKIE_KEY_SECRET_NAME` (for example `DROP_DRIVE_COOKIE_KEY_STAGING`). Then **Retry build** or push. With `npm run deploy:self`, set the same variables in your shell. The bindings exist only in builds made with these variables set: a build or deploy run without them deploys a Worker with no `SS_*` bindings, and the drives fall back to Worker secrets (or turn off).
4. The build binds `SS_GOOGLE_CLIENT_ID`, `SS_GOOGLE_CLIENT_SECRET`, `SS_MS_CLIENT_ID`, `SS_MS_CLIENT_SECRET` and `SS_DRIVE_COOKIE_KEY`. Reload `/setup`: each item shows its source (Secrets Store, Worker secret, build value, not set, or store error).

The Worker reads a Secrets Store value first and falls back to the Worker secret of the same name when the store value is empty or `none`; the client IDs then fall back to a value baked in at build time (`VITE_GOOGLE_CLIENT_ID`, `VITE_MS_CLIENT_ID`), if any. Read order: Secrets Store → Worker secret → build value. A store error (missing secret, wrong name, scope without Workers) counts as not set, so that drive stays off until it is fixed. Store values are cached for about a minute, so a rotated value can take that long to apply. `ALLOWED_ORIGINS` stays a Worker secret (it differs per site). Deploying needs a role or API token that can bind Secrets Store secrets (Super Administrator, Secrets Store Deployer, or Account Secrets Store Edit).

## Your own domain

1. The domain's zone must be on your Cloudflare account. Worker → **Settings → Domains & Routes → Add → Custom domain**, e.g. `drop.example.com`.
2. If you set `ALLOWED_ORIGINS`, add `https://drop.example.com` to it (keep the workers.dev origin too if you still use it). Unset, nothing to do: the new domain is its own origin.
3. Add the new callback URLs (open `/setup` on the new domain to copy them) to the Google client (plus the JavaScript origin) and to the Azure app.
4. Optional: to keep the domain and turn off workers.dev for good, edit `wrangler.jsonc` in your copy (`"workers_dev": false` and `"routes": [{ "pattern": "drop.example.com", "custom_domain": true }]`) and push. Otherwise the next build re-enables workers.dev as the file says.

## Keeping it running

- **Azure client secret expires** (24 months at most). Put a reminder a month before. Create a new secret, update `MS_CLIENT_SECRET`, then delete the old one. Users stay signed in.
- **Google client secret**: rotate the same way if it leaks (Clients → your client → add secret).
- **Updates**: your repository is a copy, not a fork. To pick up changes: `git remote add upstream https://github.com/TopCircle/DropRevive && git pull upstream main && git push`. The push redeploys.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `workers.dev` address does not open after the first one-click deploy | Workers & Pages → your Worker → **Settings → Domains & Routes**: turn on **workers.dev**. Only needed once; later deploys keep it on |
| Drive shows "not configured" | Its client ID, its client secret or `DRIVE_COOKIE_KEY` is unset, `none` or invalid; see `/setup` |
| Build log: `The following required secrets have not been set` | Your copy is from an older version that required secrets. Add the six in **Settings → Variables and Secrets** (`none` for what you do not have yet) and **Retry build**, or update your copy from upstream |
| `redirect_uri_mismatch` (Google) or `AADSTS50011` (Azure) | The callback URL in the console differs from the one `/setup` shows (scheme, domain, path) |
| `origin_not_allowed` / sign-in or pairing refused (P2P room creation 403) | `ALLOWED_ORIGINS` is set but does not list this address (or has only malformed entries): add it, or delete the variable for same-origin only |
| Google sign-in lapses after a week | Consent screen still in Testing; publish it |
| Signed out on every device | `DRIVE_COOKIE_KEY` was changed, or a client secret expired |
| Build log: `Missing entry-point to Worker script or to assets directory` | The site was not built before `wrangler deploy` (a copy made from an older version of the repository). Workers & Pages → your Worker → **Settings → Build**: set **Deploy command** to `npm run deploy` (it builds, checks and deploys; **Build command** can stay empty or be `npm run build`), save, then **Deployments → Retry build** |
