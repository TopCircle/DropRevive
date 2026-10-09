/**
 * Module hooks for store.test.ts and http.test.ts only (registered from inside those tests). They resolve the
 * app's "@/…" alias and extensionless imports the way Vite does, and give store.ts and its
 * store-*.ts modules in-memory fakes (store.test-fakes.ts) for the modules that reach the
 * browser, the Worker or the drives.
 */
const SRC = new URL("../../", import.meta.url).href;
const FAKES = new URL("./store.test-fakes.ts", import.meta.url).href;
const FAKED = new Set(["sonner", "./drive-token", "./google", "./microsoft", "./idb", "./client-env", "./secrets"]);

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: { parentURL?: string }) => Promise<{ url: string }>} next
 */
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  // store.ts and the store-*.ts modules it is split into.
  if (/\/src\/lib\/drop\/store(-[a-z]+)?\.ts$/.test(parent) && FAKED.has(specifier)) {
    return { url: FAKES, shortCircuit: true };
  }
  // The real drive clients (http.test.ts), with the Worker's token and local storage faked.
  if (/\/src\/lib\/drop\/(google|microsoft)\.ts$/.test(parent) && (specifier === "./drive-token" || specifier === "./secrets")) {
    return { url: FAKES, shortCircuit: true };
  }
  const target = specifier.startsWith("@/") ? SRC + specifier.slice(2) : specifier;
  const local = target.startsWith(".") || target.startsWith(SRC);
  if (local && !/\.[cm]?[jt]sx?$/.test(target)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try {
        return await next(target + suffix, context);
      } catch {
        // try the next form
      }
    }
  }
  return next(target, context);
}
