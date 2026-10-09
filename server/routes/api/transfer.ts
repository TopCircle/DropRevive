import { defineHandler } from "nitro";
import { handleTransferRequest, type TransferHttpEnv } from "../../transfer-http.ts";

type BoundRequest = Request & { runtime?: { cloudflare?: { env?: TransferHttpEnv } } };

export default defineHandler(async (event) => {
  const request = event.req as BoundRequest;
  return handleTransferRequest(request, request.runtime?.cloudflare?.env ?? null);
});
