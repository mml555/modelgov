import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { handleGlobalBudgetAlert } from "../src/modules/usage/budgetAlerts";

// The outbox is the normal delivery route. When the outbox INSERT itself fails
// (DB degraded — exactly when a budget alert matters most) handleGlobalBudgetAlert
// falls back to POSTing directly. That fallback sink was entirely untested, yet it
// re-implements the HMAC signing, SSRF guard, and redirect refusal that the outbox
// sink has; a divergence here leaks a signed payload to an internal address.

/** Pool stub: the alert claim succeeds, the outbox enqueue fails. */
function poolWithFailingOutbox(): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("budget_alert_sent")) return { rowCount: 1, rows: [{ scope: "global_monthly" }] };
      if (sql.includes("webhook_outbox")) throw new Error("relation webhook_outbox does not exist");
      return { rowCount: 0, rows: [] };
    }),
  } as unknown as Pool;
}

const payload = {
  globalSpendUsd: 85,
  alertThresholdUsd: 80,
  alertAtPercent: 80,
  monthlyCapUsd: 100,
  now: new Date("2026-06-30T12:00:00Z"),
};

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

/** deliverWebhook is fire-and-forget (`void`); let its microtasks settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("budget alert fallback delivery (outbox enqueue failed)", () => {
  it("POSTs directly and signs the body with the shared secret", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, type: "basic" }) as Response);
    const log = makeLog();

    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "https://hooks.example.com/budget", secret: "s3cret", fetchImpl },
      payload,
      log,
    );
    await flush();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://hooks.example.com/budget" }),
      "budget alert outbox enqueue failed",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/budget");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");

    // The signature must cover the exact bytes sent, or the receiver rejects it.
    const headers = init.headers as Record<string, string>;
    const expected = createHmac("sha256", "s3cret").update(init.body as string).digest("hex");
    expect(headers["x-modelgov-signature"]).toBe(`sha256=${expected}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "budget.alert",
      scope: "global_monthly",
      windowStart: "2026-06-01",
      globalSpendUsd: 85,
      monthlyCapUsd: 100,
    });
  });

  it("omits the signature header when no secret is configured", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, type: "basic" }) as Response);
    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "https://hooks.example.com/budget", fetchImpl },
      payload,
      makeLog(),
    );
    await flush();

    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["x-modelgov-signature"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("applies the SSRF guard — a private destination is never fetched", async () => {
    const fetchImpl = vi.fn();
    const log = makeLog();
    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "http://169.254.169.254/latest/meta-data", fetchImpl: fetchImpl as unknown as typeof fetch },
      payload,
      log,
    );
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      "budget alert webhook delivery failed",
    );
  });

  it("allows a private destination when the operator opted in", async () => {
    // Mirrors BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE.
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, type: "basic" }) as Response);
    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "http://10.0.0.5/hook", fetchImpl, allowPrivateHosts: true },
      payload,
      makeLog(),
    );
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to follow a redirect instead of re-POSTing to the new location", async () => {
    const log = makeLog();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 302, type: "basic" }) as Response);
    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "https://hooks.example.com/budget", secret: "s", fetchImpl },
      payload,
      log,
    );
    await flush();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 302 }),
      "budget alert webhook attempted a redirect; refusing to follow (SSRF guard)",
    );
  });

  it("treats an opaqueredirect response as a refused redirect", async () => {
    const log = makeLog();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 0, type: "opaqueredirect" }) as Response);
    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      { url: "https://hooks.example.com/budget", fetchImpl },
      payload,
      log,
    );
    await flush();
    expect(log.error).toHaveBeenCalledWith(
      expect.anything(),
      "budget alert webhook attempted a redirect; refusing to follow (SSRF guard)",
    );
  });

  it("logs a non-2xx response without throwing", async () => {
    const log = makeLog();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, type: "basic" }) as Response);
    await expect(
      handleGlobalBudgetAlert(
        poolWithFailingOutbox(),
        { url: "https://hooks.example.com/budget", fetchImpl },
        payload,
        log,
      ),
    ).resolves.toBeUndefined();
    await flush();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      "budget alert webhook returned non-2xx",
    );
  });

  it("swallows a delivery throw — an alert must never fail the caller", async () => {
    const log = makeLog();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      handleGlobalBudgetAlert(
        poolWithFailingOutbox(),
        { url: "https://hooks.example.com/budget", fetchImpl: fetchImpl as unknown as typeof fetch },
        payload,
        log,
      ),
    ).resolves.toBeUndefined();
    await flush();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      "budget alert webhook delivery failed",
    );
  });
});

describe("budget alert fallback timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts a hung fallback POST at the configured timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    });
    const log = makeLog();

    await handleGlobalBudgetAlert(
      poolWithFailingOutbox(),
      {
        url: "https://hooks.example.com/budget",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 250,
      },
      payload,
      log,
    );

    await vi.advanceTimersByTimeAsync(249);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal?.aborted).toBe(true);
  });
});
