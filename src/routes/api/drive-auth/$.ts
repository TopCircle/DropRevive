import { createFileRoute } from "@tanstack/react-router";
import { handleDriveAuth } from "@/lib/drop/oauth.server";
import { envValue } from "@/lib/runtime-config";
import { serverClientIds } from "@/lib/server-config";

// Everything comes from Worker secrets (process.env on Workers). Client IDs fall back to the
// build-time VITE_* values; "none" placeholders count as unset.
const handle = ({ request }: { request: Request }) => {
  const ids = serverClientIds();
  return handleDriveAuth(request, {
    googleClientId: ids.googleClientId,
    googleClientSecret: envValue(process.env.GOOGLE_CLIENT_SECRET),
    msClientId: ids.msClientId,
    msClientSecret: envValue(process.env.MS_CLIENT_SECRET),
    cookieKey: envValue(process.env.DRIVE_COOKIE_KEY),
    allowedOriginsRaw: envValue(process.env.ALLOWED_ORIGINS),
  });
};

export const Route = createFileRoute("/api/drive-auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
