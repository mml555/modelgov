import { describe, expect, it, vi } from "vitest";
import { deliverOutboxWebhook } from "../src/services/webhookOutbox";

const entry = (destinationUrl: string, secret?: string) => ({
  // bigserial: pg hands back bigint as a string, so the row shape uses string ids.
  id: "1",
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

  it("refuses alternate encodings of private IPv4 addresses", async () => {
    const fetchImpl = vi.fn();
    // 2130706433 = 127.0.0.1 (decimal), 0x7f000001 (hex), 017700000001 (octal),
    // 127.1 (two-part inet_aton), ::ffff:127.0.0.1 (IPv4-mapped IPv6),
    // 100.64.0.1 (CGNAT).
    for (const host of [
      "2130706433",
      "0x7f000001",
      "017700000001",
      "127.1",
      "[::ffff:127.0.0.1]",
      "100.64.0.1",
      "0.0.0.7",
    ]) {
      await expect(
        deliverOutboxWebhook(entry(`http://${host}/hook`), fetchImpl as unknown as typeof fetch),
      ).rejects.toThrow(/private|SSRF/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses IPv6 private ranges and the trailing-dot loopback FQDN", async () => {
    const fetchImpl = vi.fn();
    // fe80::/10 link-local, fc00::/7 + fd00 unique-local, and "localhost." (the
    // FQDN root form) all resolve to internal hosts but slip past a naive guard.
    for (const host of ["[fe80::1]", "[fc00::1]", "[fd00::1]", "localhost."]) {
      await expect(
        deliverOutboxWebhook(entry(`http://${host}/hook`), fetchImpl as unknown as typeof fetch),
      ).rejects.toThrow(/private|SSRF/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses IPv6 that embeds a private IPv4 outside the ::ffff: prefix", async () => {
    const fetchImpl = vi.fn();
    // IPv4-compatible (::127.0.0.1 -> [::7f00:1]), the expanded loopback form,
    // and the well-known NAT64 prefix wrapping loopback / the cloud-metadata IP —
    // all decode to an internal IPv4 and must be blocked, not just ::ffff:.
    for (const host of [
      "[::127.0.0.1]",
      "[0:0:0:0:0:0:0:1]",
      "[64:ff9b::127.0.0.1]",
      "[64:ff9b::a9fe:a9fe]",
      // 2002::/16 (6to4) embeds the IPv4 in words 1-2: 2002:a9fe:a9fe:: is the
      // cloud-metadata IP 169.254.169.254 wrapped for 6to4.
      "[2002:a9fe:a9fe::]",
      "[2002:7f00:1::]",
      // fec0::/10 deprecated site-local.
      "[fec0::1]",
    ]) {
      await expect(
        deliverOutboxWebhook(entry(`http://${host}/hook`), fetchImpl as unknown as typeof fetch),
      ).rejects.toThrow(/private|SSRF/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers to a genuine public IPv6 (low bits that merely look private are not over-blocked)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await deliverOutboxWebhook(
      entry("http://[2001:db8::7f00:1]/hook"),
      fetchImpl as unknown as typeof fetch,
    );
    // 6to4 wrapping a PUBLIC IPv4 (2002:0808:0808:: = 8.8.8.8) must not be over-blocked.
    await deliverOutboxWebhook(
      entry("http://[2002:808:808::]/hook"),
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to follow a redirect (a public host bouncing to an internal one)", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init: RequestInit) =>
      ({ ok: false, status: 302 }) as Response,
    );
    await expect(
      deliverOutboxWebhook(
        entry("https://hooks.example.com/x"),
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/redirect/i);
    // Delivery was attempted with redirect:"manual" so the 30x is not followed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe("manual");
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
