import { createFileRoute } from "@tanstack/react-router";
import { serverClientIds } from "@/lib/server-config";

// The public OAuth client IDs this Worker uses (never secrets). The page itself gets them
// during SSR; this is for diagnostics and scripts.
const handle = () =>
  Response.json(serverClientIds(), { headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/config")({
  server: { handlers: { GET: handle } },
});
