import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverOutboxWebhook } from "../src/services/webhookOutbox";

// The 10s abort is what stops one hung webhook endpoint from wedging the whole
// maintenance sweep (delivery is awaited serially per claimed row). Fake timers
// let us assert it fires without waiting out the real timeout.
describe("deliverOutboxWebhook timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const entry = {
    id: "1",
    payload: { hello: "world" },
    destinationUrl: "https://hooks.example.com/hook",
    attempts: 0,
  };

  it("aborts the request after 10s when the endpoint never responds", async () => {
    let capturedSignal: AbortSignal | undefined;
    // Mimic fetch's contract: reject with an abort error when the signal fires.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    // Attach the handler immediately: the rejection lands *during* the timer
    // advance below, and an assertion added afterwards would arrive a tick too
    // late — reported as an unhandled rejection rather than a caught one.
    const settled = deliverOutboxWebhook(
      entry,
      fetchImpl as unknown as typeof fetch,
    ).catch((e: unknown) => e);

    // Nothing has aborted yet at 9.999s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(capturedSignal?.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(Error);
    expect(String(await settled)).toMatch(/abort/i);
  });

  it("clears the timer on a successful delivery (no dangling handle)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, type: "basic" }) as Response);
    await deliverOutboxWebhook(entry, fetchImpl as unknown as typeof fetch);
    // A leaked 10s timer would keep the process/vitest worker alive; the finally
    // block must have cleared it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer even when delivery throws", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, type: "basic" }) as Response);
    await expect(
      deliverOutboxWebhook(entry, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/500/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
