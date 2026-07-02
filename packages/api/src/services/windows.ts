// Budget window buckets. v1 uses UTC (per-project timezone is post-MVP).
// Returns 'YYYY-MM-DD' strings suitable for a Postgres `date` column.

/** The UTC day bucket, e.g. "2026-06-30". */
export function dayWindowStart(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC month bucket (first of the month), e.g. "2026-06-01". */
export function monthWindowStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}
