interface DurableObjectStorageSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[]; one(): T };
}

interface DurableObjectStorage {
  sql: DurableObjectStorageSql;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectNamespace {
  getByName(name: string): DurableObjectStub;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
  create(input: { code: string; hostToken: string; hostName: string }): Promise<{ code: string; hostToken: string; expiresAt: number }>;
  join(input: { guestToken: string; guestName: string }): Promise<{ guestToken: string; hostName: string; expiresAt: number }>;
  allow(kind: string, ip: string, now?: number): Promise<boolean>;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    ctx: DurableObjectState;
    env: Env;
  }
}
