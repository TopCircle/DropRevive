import { createFileRoute } from "@tanstack/react-router";
import { handleDriveAuth } from "@/lib/drop/oauth.server";
import { envValue, resolveClientIds } from "@/lib/runtime-config";
import { BUILD_CLIENT_IDS, serverConfig } from "@/lib/server-config";

// Settings come from the Cloudflare env: Secrets Store bindings (SS_<KEY>) first, then Worker
// secrets; client IDs fall back to the build-time VITE_* values. "none" placeholders count as unset.
const handle = async ({ request }: { request: Request }) => {
  const { env } = await serverConfig(request);
  const ids = resolveClientIds(env, BUILD_CLIENT_IDS);
  return handleDriveAuth(request, {
    googleClientId: ids.googleClientId,
    googleClientSecret: envValue(env.GOOGLE_CLIENT_SECRET),
    msClientId: ids.msClientId,
    msClientSecret: envValue(env.MS_CLIENT_SECRET),
    cookieKey: envValue(env.DRIVE_COOKIE_KEY),
    allowedOriginsRaw: envValue(env.ALLOWED_ORIGINS),
  });
};

export const Route = createFileRoute("/api/drive-auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
