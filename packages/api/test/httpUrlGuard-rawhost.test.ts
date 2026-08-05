import { describe, expect, it } from "vitest";
import { isPrivateHttpHost } from "../src/util/httpUrlGuard";

// isPrivateHttpHost has TWO kinds of caller, and they hand it different shapes:
//
//  1. assertPublicHttpUrl passes `URL.hostname`, which WHATWG has already
//     normalized — `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`.
//  2. ssrfGuardedLookup (services/documents/util.ts) passes a RAW address
//     straight from dns.lookup. With V4MAPPED results Node yields the dotted
//     form `::ffff:127.0.0.1`, unbracketed and un-normalized.
//
// Every existing guard test goes through path 1, so the dotted-quad IPv6 tail
// decoder was never exercised — even though path 2 is the connect-time SSRF
// boundary for the document-AI egress. These cases cover it directly.
describe("isPrivateHttpHost with raw (un-normalized) DNS addresses", () => {
  it("blocks a V4-mapped loopback in dotted form, unbracketed", () => {
    expect(isPrivateHttpHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks the cloud metadata address in V4-mapped dotted form", () => {
    // The single most important address to block on this path.
    expect(isPrivateHttpHost("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 and CGNAT ranges in V4-mapped dotted form", () => {
    expect(isPrivateHttpHost("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateHttpHost("::ffff:172.16.3.4")).toBe(true);
    expect(isPrivateHttpHost("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateHttpHost("::ffff:100.64.0.1")).toBe(true);
  });

  it("blocks an IPv4-compatible (::) dotted embedding", () => {
    expect(isPrivateHttpHost("::127.0.0.1")).toBe(true);
    expect(isPrivateHttpHost("::10.0.0.1")).toBe(true);
  });

  it("blocks a NAT64-wrapped private IPv4 in dotted form", () => {
    expect(isPrivateHttpHost("64:ff9b::10.0.0.1")).toBe(true);
    expect(isPrivateHttpHost("64:ff9b::169.254.169.254")).toBe(true);
  });

  it("allows a V4-mapped PUBLIC address (no over-blocking)", () => {
    expect(isPrivateHttpHost("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateHttpHost("64:ff9b::8.8.8.8")).toBe(false);
  });

  it("fails CLOSED on a malformed dotted tail rather than reading it as public", () => {
    // Out-of-range and non-numeric octets make ipv4DottedValue return null, which
    // makes the whole literal unparseable — and an unparseable IPv6 host is
    // treated as private (fail closed), never waved through.
    expect(isPrivateHttpHost("::ffff:999.0.0.1")).toBe(true);
    expect(isPrivateHttpHost("::ffff:1.2.3")).toBe(true);
    expect(isPrivateHttpHost("::ffff:1.2.3.4.5")).toBe(true);
    expect(isPrivateHttpHost("::ffff:0x7f.0.0.1")).toBe(true);
    expect(isPrivateHttpHost("::ffff:a.b.c.d")).toBe(true);
  });

  it("rejects a dotted quad that is not the final group", () => {
    // The embedded IPv4 may only be the tail; anything else is malformed and
    // must fail closed.
    expect(isPrivateHttpHost("::ffff:127.0.0.1:1")).toBe(true);
  });

  it("still handles plain IPv4 and IPv6 addresses from dns.lookup", () => {
    expect(isPrivateHttpHost("127.0.0.1")).toBe(true);
    expect(isPrivateHttpHost("169.254.169.254")).toBe(true);
    expect(isPrivateHttpHost("::1")).toBe(true);
    expect(isPrivateHttpHost("fe80::1")).toBe(true);
    expect(isPrivateHttpHost("fc00::1")).toBe(true);
    expect(isPrivateHttpHost("8.8.8.8")).toBe(false);
    expect(isPrivateHttpHost("2606:4700::1111")).toBe(false);
  });
});
