/**
 * SSRF-adjacent host checks for outbound webhook URLs. Kept dependency-free so
 * both boot-time config validation (bootstrap) and the runtime delivery sink
 * (webhook outbox) can share it without an import cycle.
 */

/** True if host is loopback / link-local / RFC1918 private (SSRF-adjacent). */
export function isPrivateHttpHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}
