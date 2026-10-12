import { createFileRoute } from "@tanstack/react-router";
import { serverClientConfig } from "@/lib/server-config";

// The public OAuth client IDs this Worker uses and which drives are on (never secrets). The
// page itself gets this during SSR; this is for diagnostics and scripts.
const handle = async ({ request }: { request: Request }) =>
  Response.json(await serverClientConfig(request), { headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/config")({
  server: { handlers: { GET: handle } },
});
