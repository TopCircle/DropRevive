/**
 * Server functions that read the Worker's settings. The root route loads the client config
 * during SSR, so the first paint already knows which drives are on (no flash of "not
 * configured"); /setup loads its self-check the same way.
 *
 * Settings come from the Cloudflare env (Secrets Store bindings SS_<KEY> first, then Worker
 * secrets; runtime-config resolveConfigEnv), not `process.env`, which only carries strings.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  resolveConfigEnv,
  type BuildClientIds,
  type ClientConfig,
  type ResolvedConfig,
} from "./runtime-config";
import { clientConfig, setupStatus } from "./setup-status";

/** Build-time IDs (deploy:production / deploy:staging still pass them): the fallback. */
export const BUILD_CLIENT_IDS: BuildClientIds = {
  google: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  microsoft: import.meta.env.VITE_MS_CLIENT_ID,
};

type CloudflareRequest = Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } };

/**
 * The Worker's env for this request: nitro attaches it to the request (runtime.cloudflare.env)
 * and to globalThis.__env__ (cloudflare_module preset). `vite dev` runs in Node: process.env.
 */
export function cloudflareEnv(request?: Request): Record<string, unknown> {
  const fromRequest = (request as CloudflareRequest | undefined)?.runtime?.cloudflare?.env;
  if (fromRequest) return fromRequest;
  const fromGlobal = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  if (fromGlobal) return fromGlobal;
  return typeof process === "undefined" ? {} : (process.env as Record<string, unknown>);
}

/** This request's settings (strings) and where each came from. */
export function serverConfig(request?: Request): Promise<ResolvedConfig> {
  return resolveConfigEnv(cloudflareEnv(request), BUILD_CLIENT_IDS);
}

/** Public client IDs plus which drives can sign in on the address this request came to. */
export async function serverClientConfig(request: Request): Promise<ClientConfig> {
  const { env } = await serverConfig(request);
  return clientConfig(env, request.url, BUILD_CLIENT_IDS);
}

export const getClientConfig = createServerFn({ method: "GET" }).handler(() => serverClientConfig(getRequest()));

export const getSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const { env, sources } = await serverConfig(request);
  return setupStatus(env, request.url, BUILD_CLIENT_IDS, sources);
});
