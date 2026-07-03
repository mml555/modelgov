import { describe, expect, it, vi } from "vitest";
import { deliverOutboxWebhook } from "../src/modules/billing/routes";

const entry = (destinationUrl: string, secret?: string) => ({
  id: 1,
  payload: { hello: "world" },
  destinationUrl,
  secret,
  attempts: 0,
});

describe("deliverOutboxWebhook SSRF guard", () => {
  it("refuses private/link-local hosts and never calls fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverOutboxWebhook(entry("http://127.0.0.1/hook"), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/private|SSRF/i);
    await expect(
      deliverOutboxWebhook(
        entry("http://169.254.169.254/latest/meta-data"),
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/private|SSRF/i);
    await expect(
      deliverOutboxWebhook(entry("http://10.1.2.3/hook"), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/private|SSRF/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) and malformed destination URLs", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverOutboxWebhook(entry("ftp://example.com/x"), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/http\(s\)/);
    await expect(
      deliverOutboxWebhook(entry("not a url"), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/invalid/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers to a private host only when allowPrivateHosts is opted in", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await deliverOutboxWebhook(
      entry("http://10.0.0.5/hook"),
      fetchImpl as unknown as typeof fetch,
      { allowPrivateHosts: true },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("delivers to a public host and signs the payload when a secret is present", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return { ok: true } as Response;
    });
    await deliverOutboxWebhook(
      entry("https://hooks.example.com/x", "shh"),
      fetchImpl as unknown as typeof fetch,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example.com/x");
    expect(calls[0]?.headers["x-modelgov-signature"]).toMatch(/^sha256=/);
  });
});
