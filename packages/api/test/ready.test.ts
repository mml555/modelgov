import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { checkReady } from "../src/modules/health/service";

describe("checkReady", () => {
  it("reports ready when database and mocked deps respond", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
    } as unknown as Pool;

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("fail", { status: 503 });
    });

    const ready = await checkReady({
      pool,
      litellmBaseUrl: "http://litellm:4000",
      presidioAnalyzerUrl: "http://presidio-analyzer:3000",
      presidioAnonymizerUrl: "http://presidio-anonymizer:3000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(ready.status).toBe("ready");
    expect(ready.checks.database).toBe("ok");
    expect(ready.checks.litellm).toBe("ok");
    expect(ready.checks.presidio).toBe("ok");
  });

  it("skips optional deps when URLs are omitted", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
    } as unknown as Pool;

    const ready = await checkReady({ pool });
    expect(ready.status).toBe("ready");
    expect(ready.checks.litellm).toBe("skipped");
    expect(ready.checks.presidio).toBe("skipped");
  });
});
