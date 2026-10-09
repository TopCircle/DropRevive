import { createFileRoute } from "@tanstack/react-router";
import { GOOGLE_CLIENT_ID, MS_CLIENT_ID } from "@/lib/drop/client-env";
import { handleDriveAuth } from "@/lib/drop/oauth.server";

// Secrets and ALLOWED_ORIGINS come from `wrangler secret put` (process.env on Workers);
// client IDs are baked in at build.
const handle = ({ request }: { request: Request }) =>
  handleDriveAuth(request, {
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    msClientId: MS_CLIENT_ID,
    msClientSecret: process.env.MS_CLIENT_SECRET,
    cookieKey: process.env.DRIVE_COOKIE_KEY,
    allowedOriginsRaw: process.env.ALLOWED_ORIGINS,
  });

export const Route = createFileRoute("/api/drive-auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
