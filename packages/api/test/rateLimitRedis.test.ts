import { describe, expect, it } from "vitest";
import { createRateLimitRedis, connectRateLimitRedis } from "../src/services/rateLimitRedis";

describe("rateLimitRedis", () => {
  it("creates a client with fail-fast settings", () => {
    const client = createRateLimitRedis({ url: "redis://127.0.0.1:6379" });
    expect(client.options.connectTimeout).toBe(500);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.enableOfflineQueue).toBe(false);
    expect(client.options.lazyConnect).toBe(true);
    client.disconnect();
  });

  it("connectRateLimitRedis rejects when the server is unreachable", async () => {
    const client = createRateLimitRedis({ url: "redis://127.0.0.1:6399" });
    await expect(connectRateLimitRedis(client)).rejects.toThrow();
    await client.quit().catch(() => {});
  }, 10_000);
});
