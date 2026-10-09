import { TransferRoom } from "./transfer-room.ts";

export class TransferRoomTest extends TransferRoom {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-test-alarm") === "1") {
      await this.alarm();
      return new Response(null, { status: 204 });
    }
    return super.fetch(request);
  }
}

export default {
  fetch(): Response {
    return new Response("not-the-room", { status: 404 });
  },
};
