import assert from "node:assert/strict";
import test from "node:test";
import { handleTransferRequest } from "../../../server/transfer-http.ts";
import { lostSocketNeedsFail, modeForTransferSearch, receivedWouldDrop, takeRoomResponse, withoutTransferSearch } from "./panel-flow.ts";

test("a transfer query opens direct mode", () => {
  assert.equal(modeForTransferSearch("?transfer=T5YUB6Y8"), "direct");
  assert.equal(modeForTransferSearch("?transfer=t5yub6y8"), "direct");
  assert.equal(modeForTransferSearch(""), "cloud");
  assert.equal(modeForTransferSearch("?transfer=IIIIIIII"), "cloud");
  assert.equal(modeForTransferSearch("?other=T5YUB6Y8"), "cloud");
});

test("a consumed room code leaves the address bar", () => {
  assert.equal(withoutTransferSearch("?transfer=T5YUB6Y8"), "");
  assert.equal(withoutTransferSearch("?transfer=T5YUB6Y8&x=1"), "?x=1");
  assert.equal(withoutTransferSearch(""), "");
});

test("a thrown room request fails only while the panel is mounted", async () => {
  let alive = true;
  const unmounted = await takeRoomResponse(async () => {
    alive = false;
    throw new Error("network");
  }, () => alive);
  assert.deepEqual(unmounted, { ok: false, reason: "unmounted" });

  const thrown = await takeRoomResponse(async () => {
    throw new Error("network");
  }, () => true);
  assert.deepEqual(thrown, { ok: false, reason: "thrown" });

  let still = true;
  const dropped = await takeRoomResponse(async () => {
    still = false;
    return 1;
  }, () => still);
  assert.deepEqual(dropped, { ok: false, reason: "unmounted" });

  const kept = await takeRoomResponse(async () => 1, () => true);
  assert.deepEqual(kept, { ok: true, value: 1 });
});

test("a socket close fails the transfer only while it is still in progress", () => {
  assert.equal(lostSocketNeedsFail({ alive: true, quiet: false, finished: false }), true);
  assert.equal(lostSocketNeedsFail({ alive: false, quiet: false, finished: false }), false);
  assert.equal(lostSocketNeedsFail({ alive: true, quiet: true, finished: false }), false);
  assert.equal(lostSocketNeedsFail({ alive: true, quiet: false, finished: true }), false);
});

test("leaving direct mode would drop received text and unsaved files", () => {
  assert.equal(receivedWouldDrop({ textReady: true, pendingFiles: 0 }), true);
  assert.equal(receivedWouldDrop({ textReady: false, pendingFiles: 1 }), true);
  assert.equal(receivedWouldDrop({ textReady: false, pendingFiles: 0 }), false);
});

test("a websocket is refused before the room object is addressed", async () => {
  const rooms: string[] = [];
  let joinChecks = 0;
  const env = {
    ALLOWED_ORIGINS: "https://staging.example.com",
    TRANSFER_GATE: {
      getByName() {
        return {
          allow: async (kind: string) => {
            if (kind === "join") joinChecks += 1;
            return false;
          },
        };
      },
    },
    TRANSFER_ROOM: {
      getByName(name: string) {
        rooms.push(name);
        return {
          fetch: async () => new Response("open", { status: 200 }),
          create: async () => ({ code: name, hostToken: "token", expiresAt: 1 }),
          join: async () => ({ guestToken: "token", hostName: "host", expiresAt: 1 }),
        };
      },
    },
  };
  const response = await handleTransferRequest(
    new Request("https://staging.example.com/api/transfer/ws?code=T5YUB6Y8", {
      headers: { origin: "https://staging.example.com" },
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.equal(joinChecks, 1);
  assert.deepEqual(rooms, []);
});
