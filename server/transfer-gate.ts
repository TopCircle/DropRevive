import { DurableObject } from "cloudflare:workers";
import { allowHit, type Hit } from "../src/lib/transfer/limit.ts";
import { CREATE_PER_WINDOW, JOIN_PER_WINDOW, LIMIT_WINDOW_MS } from "../src/lib/transfer/limits.ts";

export class TransferGate extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hits (
          key TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL
        )
      `);
    });
  }

  async allow(kind: string, ip: string, now = Date.now()): Promise<boolean> {
    const limit = kind === "create" ? CREATE_PER_WINDOW : JOIN_PER_WINDOW;
    const key = `${kind}:${ip || "unknown"}`;
    const row = this.ctx.storage.sql
      .exec<{ key: string; window_start: number; count: number }>("SELECT key, window_start, count FROM hits WHERE key = ?", key)
      .toArray()[0];
    const state: Hit | null = row ? { windowStart: row.window_start, count: row.count } : null;
    const result = allowHit(state, now, limit, LIMIT_WINDOW_MS);
    this.ctx.storage.sql.exec(
      `INSERT INTO hits (key, window_start, count) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
      key,
      result.next.windowStart,
      result.next.count,
    );
    await this.ctx.storage.setAlarm(now + LIMIT_WINDOW_MS);
    return result.ok;
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE window_start < ?", Date.now() - LIMIT_WINDOW_MS);
  }
}
