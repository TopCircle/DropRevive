/**
 * Which Worker a build targets. The tracked wrangler.jsonc is the public profile: what the
 * Deploy to Cloudflare button and self-hosters deploy (a workers.dev Worker named
 * "droprevive", no route). The maintainer's production site is a named profile chosen at
 * build time with DROP_PROFILE=production; vite.config.ts hands its overrides to nitro, which
 * merges them over wrangler.jsonc into .output/server/wrangler.json.
 *
 * Staging is the public build renamed by scripts/deploy-staging.mjs (STAGING_WORKER).
 *
 * No framework imports: vite.config.ts, the deploy scripts and node --test share it.
 */

export const PRODUCTION_WORKER = "dropreceive";
export const PRODUCTION_HOST = "drop.habor.dpdns.org";
export const PUBLIC_WORKER = "droprevive";
export const PROFILE_VAR = "DROP_PROFILE";

/**
 * Worker secrets the app reads. All optional (deploy first, configure later): wrangler.jsonc
 * declares none as required; .dev.vars.example and package.json "cloudflare.bindings" describe them.
 */
export const CONFIG_SECRETS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "DRIVE_COOKIE_KEY",
  "ALLOWED_ORIGINS",
];

/**
 * Optional Cloudflare Secrets Store (account-level secrets shared by Workers of one account).
 * Off unless DROP_SECRETS_STORE_ID is set when building: then the build binds SS_<KEY> to the
 * store secrets below and the app reads them before the plain Worker secrets
 * (src/lib/runtime-config.ts resolveConfigEnv). No profile adds them by default, so the button
 * deploy and the production / staging configs are unchanged.
 */
export const STORE_ID_VAR = "DROP_SECRETS_STORE_ID";
export const COOKIE_SECRET_NAME_VAR = "DROP_COOKIE_KEY_SECRET_NAME";
export const DEFAULT_COOKIE_SECRET_NAME = "DROP_DRIVE_COOKIE_KEY";
export const STORE_SECRET_NAMES = {
  GOOGLE_CLIENT_ID: "DROP_GOOGLE_CLIENT_ID",
  GOOGLE_CLIENT_SECRET: "DROP_GOOGLE_CLIENT_SECRET",
  MS_CLIENT_ID: "DROP_MS_CLIENT_ID",
  MS_CLIENT_SECRET: "DROP_MS_CLIENT_SECRET",
};

/**
 * The secrets_store_secrets bindings for this build, or [] when DROP_SECRETS_STORE_ID is unset.
 * @param {Record<string, string | undefined>} env
 * @returns {{ binding: string; store_id: string; secret_name: string }[]}
 */
export function secretsStoreBindings(env) {
  const storeId = (env[STORE_ID_VAR] ?? "").trim();
  if (!storeId) return [];
  if (!/^[0-9a-f]{32}$/i.test(storeId)) {
    throw new Error(`${STORE_ID_VAR} must be the 32-character Secrets Store ID (Dashboard > Secrets Store)`);
  }
  const cookieName = (env[COOKIE_SECRET_NAME_VAR] ?? "").trim() || DEFAULT_COOKIE_SECRET_NAME;
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) {
    throw new Error(`${COOKIE_SECRET_NAME_VAR} must be a secret name without spaces`);
  }
  /** @type {[string, string][]} */
  const names = [...Object.entries(STORE_SECRET_NAMES), ["DRIVE_COOKIE_KEY", cookieName]];
  return names.map(([key, secretName]) => ({ binding: `SS_${key}`, store_id: storeId, secret_name: secretName }));
}

/** Binding names the app understands (SS_<KEY>). */
export const STORE_BINDINGS = [...Object.keys(STORE_SECRET_NAMES), "DRIVE_COOKIE_KEY"].map((key) => `SS_${key}`);

/**
 * Keys in wrangler.jsonc that only the public (button / self-host) profile uses. The maintainer's
 * production and staging deploys drop them, so their generated config stays what it was before the
 * button existed. (`secrets` is listed too: no profile may declare required secrets.)
 */
export const PUBLIC_ONLY_KEYS = ["preview_urls", "secrets"];

/**
 * A copy without the public-only keys.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function stripPublicOnly(config) {
  const copy = { ...config };
  for (const key of PUBLIC_ONLY_KEYS) delete copy[key];
  return copy;
}

/**
 * Keys in wrangler.jsonc that only a bare `wrangler deploy` from a clean checkout uses (wrangler's
 * custom build). No generated config keeps them: a deploy that follows the build would otherwise
 * build again (for production, without the production environment). check-profile.mjs,
 * deploy-staging.mjs and deploy-self.mjs drop them from .output/server/wrangler.json.
 */
export const ROOT_ONLY_KEYS = ["build"];

/**
 * A copy without the root-only keys.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function stripRootOnly(config) {
  const copy = { ...config };
  for (const key of ROOT_ONLY_KEYS) delete copy[key];
  return copy;
}

/** Key order of the production config nitro generated before the button (b8d8e19). */
export const PRODUCTION_KEY_ORDER = [
  "compatibility_date",
  "name",
  "compatibility_flags",
  "workers_dev",
  "routes",
  "durable_objects",
  "migrations",
  "main",
  "assets",
  "no_bundle",
  "rules",
];

/**
 * A copy with the keys in PRODUCTION_KEY_ORDER first (others after, in their order), so the written
 * production config is byte-identical to the one deployed before the button.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function inProductionOrder(config) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of PRODUCTION_KEY_ORDER) if (key in config) out[key] = config[key];
  for (const [key, value] of Object.entries(config)) if (!(key in out)) out[key] = value;
  return out;
}

/** @typedef {"public" | "production"} Profile */

/**
 * @param {string | undefined} raw
 * @returns {Profile}
 */
export function profileFrom(raw) {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "public") return "public";
  if (value === "production") return "production";
  throw new Error(`${PROFILE_VAR}=${raw} is not a known profile (use "production" or leave it unset)`);
}

/**
 * Wrangler settings nitro merges over wrangler.jsonc (nitro's `cloudflare.wrangler` option).
 * `env` is the build environment: DROP_SECRETS_STORE_ID there adds the Secrets Store bindings.
 * @param {Profile} profile
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, unknown>}
 */
export function profileOverrides(profile, env = {}) {
  /** @type {Record<string, unknown>} */
  const overrides =
    profile === "production"
      ? {
          name: PRODUCTION_WORKER,
          workers_dev: false,
          routes: [{ pattern: PRODUCTION_HOST, custom_domain: true }],
        }
      : {};
  const store = secretsStoreBindings(env);
  if (store.length) overrides.secrets_store_secrets = store;
  return overrides;
}

/**
 * Nitro's merge (defu): the left value wins unless it is null/undefined, plain objects merge
 * recursively, arrays concatenate (left first). Used by tests to predict the generated config.
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {Record<string, unknown>}
 */
export function mergeLikeNitro(left, right) {
  /** @type {Record<string, unknown>} */
  const out = { ...right };
  for (const [key, value] of Object.entries(left)) {
    if (value === undefined || value === null) continue;
    const base = out[key];
    if (Array.isArray(value) && Array.isArray(base)) out[key] = [...value, ...base];
    else if (isPlain(value) && isPlain(base)) out[key] = mergeLikeNitro(value, base);
    else out[key] = value;
  }
  return out;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} routes @returns {string[]} */
function patterns(routes) {
  if (!Array.isArray(routes)) return [];
  return routes.map((route) =>
    typeof route === "string" ? route : route && typeof route === "object" ? String(route.pattern ?? "") : "",
  );
}

/**
 * Why a generated wrangler config does not match the profile it was built for, or null.
 * `expectedMigrations` is the migrations list of the tracked wrangler.jsonc.
 *
 * public: any Worker name except the maintainer's (the button renames it to the repository name),
 *   workers.dev on, preview URLs off, no routes, no required secrets (a deploy must work with none set).
 * production: dropreceive, workers.dev off, exactly the custom domain, no public-only keys.
 * staging: the given name, workers.dev on, no routes, no public-only keys.
 * @param {Record<string, any>} config
 * @param {Profile | "staging"} profile
 * @param {unknown} expectedMigrations
 * @param {string} [stagingName]
 * @returns {string | null}
 */
export function profileMismatch(config, profile, expectedMigrations, stagingName) {
  const routes = patterns(config.routes ?? (config.route ? [config.route] : []));
  if (JSON.stringify(config.migrations) !== JSON.stringify(expectedMigrations)) {
    return "Durable Object migrations differ from wrangler.jsonc";
  }
  const classes = (config.durable_objects?.bindings ?? []).map((/** @type {any} */ b) => b.class_name).sort();
  if (JSON.stringify(classes) !== JSON.stringify(["TransferGate", "TransferRoom"])) {
    return "Durable Object bindings TransferRoom/TransferGate are missing";
  }
  const store = config.secrets_store_secrets;
  if (store !== undefined) {
    if (!Array.isArray(store)) return "secrets_store_secrets must be a list";
    const unknown = store.filter((/** @type {any} */ b) => !STORE_BINDINGS.includes(b?.binding) || !b?.store_id || !b?.secret_name);
    if (unknown.length) return `secrets_store_secrets has bindings the app does not read (use ${STORE_BINDINGS.join(", ")})`;
  }
  const rootOnly = ROOT_ONLY_KEYS.filter((key) => key in config);
  if (rootOnly.length) return `the generated config must not carry ${rootOnly.join(", ")} (the deploy would build again)`;
  const name = typeof config.name === "string" ? config.name.trim() : "";
  if (profile === "production") {
    if (name !== PRODUCTION_WORKER) return `name is ${config.name}, expected ${PRODUCTION_WORKER}`;
    if (config.workers_dev !== false) return "production must not enable workers.dev";
    const custom = (config.routes ?? []).some(
      (/** @type {any} */ r) => r && r.pattern === PRODUCTION_HOST && r.custom_domain === true,
    );
    if (!custom || routes.length !== 1) return `production must have exactly the custom domain ${PRODUCTION_HOST}`;
    const extra = PUBLIC_ONLY_KEYS.filter((key) => key in config);
    if (extra.length) return `production must not carry ${extra.join(", ")}`;
    return null;
  }
  if (!name) return "the Worker has no name";
  if (name === PRODUCTION_WORKER) return "must not use the production Worker name";
  if (profile === "staging" && name !== stagingName) return `name is ${config.name}, expected ${stagingName}`;
  if (config.workers_dev !== true) return "workers_dev must be true (the site lives on workers.dev)";
  if (routes.length > 0) return "must not have routes";
  if (JSON.stringify(config).includes(PRODUCTION_HOST)) return `must not mention ${PRODUCTION_HOST}`;
  if (profile === "staging") {
    const extra = PUBLIC_ONLY_KEYS.filter((key) => key in config);
    return extra.length ? `staging must not carry ${extra.join(", ")}` : null;
  }
  if (config.preview_urls !== false) return "preview_urls must be false";
  if ("secrets" in config) return "must not declare secrets (deploy first, configure later: every secret is optional)";
  return null;
}
