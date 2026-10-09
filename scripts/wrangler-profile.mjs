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
 * @param {Profile} profile
 * @returns {Record<string, unknown>}
 */
export function profileOverrides(profile) {
  if (profile === "production") {
    return {
      name: PRODUCTION_WORKER,
      workers_dev: false,
      routes: [{ pattern: PRODUCTION_HOST, custom_domain: true }],
    };
  }
  return {};
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
  if (profile === "production") {
    if (config.name !== PRODUCTION_WORKER) return `name is ${config.name}, expected ${PRODUCTION_WORKER}`;
    if (config.workers_dev !== false) return "production must not enable workers.dev";
    const custom = (config.routes ?? []).some(
      (/** @type {any} */ r) => r && r.pattern === PRODUCTION_HOST && r.custom_domain === true,
    );
    if (!custom || routes.length !== 1) return `production must have exactly the custom domain ${PRODUCTION_HOST}`;
    return null;
  }
  const expectedName = profile === "staging" ? stagingName : PUBLIC_WORKER;
  if (!expectedName || config.name !== expectedName) return `name is ${config.name}, expected ${expectedName}`;
  if (config.name === PRODUCTION_WORKER) return "must not use the production Worker name";
  if (config.workers_dev !== true) return "must deploy to workers.dev";
  if (routes.length > 0) return "must not have routes";
  if (JSON.stringify(config).includes(PRODUCTION_HOST)) return `must not mention ${PRODUCTION_HOST}`;
  return null;
}
