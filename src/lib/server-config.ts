/**
 * Server functions that read the Worker's settings. The root route loads the client config
 * during SSR, so the first paint already knows which drives are on (no flash of "not
 * configured"); /setup loads its self-check the same way.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  pickConfigEnv,
  resolveClientIds,
  type BuildClientIds,
  type ClientConfig,
} from "./runtime-config";
import { clientConfig, setupStatus } from "./setup-status";

/** Build-time IDs (deploy:production / deploy:staging still pass them): the fallback. */
export const BUILD_CLIENT_IDS: BuildClientIds = {
  google: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  microsoft: import.meta.env.VITE_MS_CLIENT_ID,
};

export function serverClientIds() {
  return resolveClientIds(pickConfigEnv(process.env), BUILD_CLIENT_IDS);
}

/** Public client IDs plus which drives can sign in on the address this request came to. */
export function serverClientConfig(requestUrl: string): ClientConfig {
  return clientConfig(pickConfigEnv(process.env), requestUrl, BUILD_CLIENT_IDS);
}

export const getClientConfig = createServerFn({ method: "GET" }).handler(() =>
  serverClientConfig(getRequest().url),
);

export const getSetupStatus = createServerFn({ method: "GET" }).handler(() =>
  setupStatus(pickConfigEnv(process.env), getRequest().url, BUILD_CLIENT_IDS),
);
