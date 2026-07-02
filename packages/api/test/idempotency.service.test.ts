import { describe, expect, it } from "vitest";
import { requestHash, withIdempotency } from "../src/modules/idempotency/service";
import type { ChatResult } from "../src/modules/chat/types";

function okResult(content = "ok"): ChatResult {
  return {
    ok: true,
    body: {
      message: { role: "assistant", content },
      model: "m",
      provider: "openai",
      decision: "allow",
      usage: { inputTokens: null, outputTokens: null },
      requestId: "req_1",
      cost: { estimatedUsd: 0, actualUsd: 0 },
      budgetRemaining: {
        userDailyUsd: 0,
        featureMonthlyUsd: 0,
        globalMonthlyUsd: 0,
      },
      safety: { piiMasked: false, injectionBlocked: false },
    },
  };
}

describe("withIdempotency", () => {
  it("runs produce once and caches completed success", async () => {
    let calls = 0;
    const store = new Map<string, { hash: string; status: string; body?: unknown }>();
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO idempotency_keys") && params) {
          const key = `${params[1]}:${params[0]}`;
          if (store.has(key)) return { rowCount: 0, rows: [] };
          store.set(key, { hash: String(params[2]), status: "processing" });
          return { rowCount: 1, rows: [{}] };
        }
        if (sql.includes("UPDATE idempotency_keys") && params) {
          const key = `${params[0]}:${params[1]}`;
          const row = store.get(key);
          if (row) {
            row.status = "completed";
            row.body = JSON.parse(String(params[3]));
          }
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SELECT request_hash")) {
          const key = `${params![0]}:${params![1]}`;
          const row = store.get(key);
          if (!row) return { rows: [] };
          return {
            rows: [{
              request_hash: row.hash,
              status: row.status,
              response_status: row.status === "completed" ? 200 : null,
              response_body: row.body ?? null,
            }],
          };
        }
        if (sql.includes("DELETE FROM idempotency_keys")) return { rowCount: 1, rows: [] };
        return { rows: [], rowCount: 0 };
      },
    };

    const body = { userId: "u1", feature: "support_chat" };
    const hash = requestHash(body);
    const first = await withIdempotency(
      pool as never,
      { key: "k1", userId: "u1", hash, captureContent: true },
      async () => {
        calls++;
        return okResult("first");
      },
    );
    const second = await withIdempotency(
      pool as never,
      { key: "k1", userId: "u1", hash, captureContent: true },
      async () => {
        calls++;
        return okResult("second");
      },
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1);
    expect(second.result.ok && second.result.body.message.content).toBe("first");
  });

  it("rejects hash mismatch with 422", async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("INSERT")) return { rowCount: 0, rows: [] };
        if (sql.includes("SELECT")) {
          return {
            rows: [{
              request_hash: "other-hash",
              status: "completed",
              response_status: 200,
              response_body: okResult(),
            }],
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const out = await withIdempotency(
      pool as never,
      { key: "k", userId: "u", hash: "mine", captureContent: true },
      async () => okResult(),
    );
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) {
      expect(out.result.status).toBe(422);
      expect(out.result.code).toBe("idempotency_key_reuse");
    }
  });
});
