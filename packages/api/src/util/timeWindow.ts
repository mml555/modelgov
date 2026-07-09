/**
 * Parse a `since` window string into a Date: `<N>h` / `<N>d` relative to now, or
 * an ISO-8601 timestamp. Throws `Error("invalid_since")` on anything else — the
 * route layer maps that to a 400. Shared by the usage summary, transaction
 * rollup, and request-list endpoints so the accepted grammar can't drift between
 * them (previously three verbatim copies).
 */
export function parseSince(raw: string, now = Date.now()): Date {
  const match = /^(\d+)(h|d)$/.exec(raw.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const ms = unit === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(now - ms);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed);
  throw new Error("invalid_since");
}
