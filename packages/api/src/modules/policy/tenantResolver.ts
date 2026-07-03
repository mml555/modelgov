import type { ModelgovConfig } from "@modelgov/policy-engine";
import type { Pool } from "pg";
import { getActiveConfigVersion } from "./repo";

/**
 * The effective policy for one request: the parsed config to evaluate against
 * plus the identity stamped on the request log (which version decided).
 */
export interface ResolvedTenantPolicy {
  config: ModelgovConfig;
  policyMeta: { configHash?: string; policyVersion?: string };
}

export interface TenantPolicyResolver {
  /** Resolve the active policy for a tenant (undefined → the default tenant). */
  resolve(tenantId: string | undefined): Promise<ResolvedTenantPolicy>;
  /** Drop a tenant's cached policy immediately (call right after activation). */
  invalidate(tenantId: string | undefined): void;
  clear(): void;
}

const DEFAULT_TENANT = "default";

/**
 * Request-time per-tenant policy resolution. Each tenant is evaluated against
 * its OWN active `config_versions` row instead of the single version loaded at
 * boot. A short TTL cache keeps the hot path off the DB and bounds how long a
 * newly-activated version takes to apply across replicas — the same model the
 * DB-backed key resolver uses for revocation. The activating replica calls
 * `invalidate()` so its own traffic switches instantly.
 *
 * A tenant with no active version falls back to `fallback` (the boot policy),
 * so an unconfigured tenant still gets a safe base policy rather than an error.
 */
export function createTenantPolicyResolver(opts: {
  pool: Pool;
  /** Used for the default tenant and any tenant with no active version. */
  fallback: ResolvedTenantPolicy;
  ttlMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}): TenantPolicyResolver {
  const { pool, fallback } = opts;
  const ttl = opts.ttlMs;
  const now = opts.now ?? Date.now;
  // Cache the in-flight promise so concurrent requests for the same tenant share
  // one DB read (and a burst can't stampede the store).
  const cache = new Map<string, { value: Promise<ResolvedTenantPolicy>; expiresAt: number }>();

  async function load(tenantId: string): Promise<ResolvedTenantPolicy> {
    const active = await getActiveConfigVersion(pool, tenantId);
    if (!active) return fallback;
    return {
      config: active.config,
      policyMeta: { configHash: active.record.checksum, policyVersion: active.record.id },
    };
  }

  return {
    async resolve(tenantId): Promise<ResolvedTenantPolicy> {
      const key = tenantId ?? DEFAULT_TENANT;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.value;

      const entry: { value: Promise<ResolvedTenantPolicy>; expiresAt: number } = {
        value: Promise.resolve(fallback), // placeholder, replaced below
        expiresAt: now() + ttl,
      };
      // Don't cache failures: if the load rejects, evict this exact entry so the
      // next request retries instead of serving a poisoned promise for the TTL.
      entry.value = load(key).catch((err) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
      cache.set(key, entry);
      return entry.value;
    },
    invalidate(tenantId): void {
      cache.delete(tenantId ?? DEFAULT_TENANT);
    },
    clear(): void {
      cache.clear();
    },
  };
}
