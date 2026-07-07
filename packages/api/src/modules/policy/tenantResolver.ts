import { type ModelgovConfig, PolicyConfigError } from "@modelgov/policy-engine";
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
  /**
   * When false (single-tenant hot reload), every request resolves the DEFAULT
   * tenant's active version regardless of the caller's tenantId — the store is
   * used only to hot-reload one policy, not to segment by tenant. Default true
   * preserves per-tenant resolution.
   */
  perTenant?: boolean;
  /**
   * Applied to each config loaded from the store, mirroring the file path's
   * `resolveEnvRefs` so a stored version can reference secrets via `env/VAR`.
   * Identity by default (no resolution). The fallback config is assumed already
   * resolved (it comes from `resolvePolicy`).
   */
  resolveConfig?: (config: ModelgovConfig) => ModelgovConfig;
  /** Logs a loudly-visible error when a tenant's stored version fails to load. */
  log?: { error(obj: unknown, msg: string): void };
  /**
   * Hard cap on distinct cached tenant keys. Bounds memory when unbound callers
   * can set an arbitrary `X-Modelgov-Tenant` — otherwise each unique value would
   * add a permanent entry. Default 5000.
   */
  maxEntries?: number;
}): TenantPolicyResolver {
  const { pool, fallback } = opts;
  const ttl = opts.ttlMs;
  const now = opts.now ?? Date.now;
  const perTenant = opts.perTenant ?? true;
  const resolveConfig = opts.resolveConfig ?? ((c) => c);
  const log = opts.log;
  const maxEntries = opts.maxEntries ?? 5000;
  // In single-tenant mode collapse every caller onto the default tenant so
  // resolve/invalidate operate on the one active version.
  const keyFor = (tenantId: string | undefined): string =>
    perTenant ? (tenantId ?? DEFAULT_TENANT) : DEFAULT_TENANT;
  // Cache the in-flight promise so concurrent requests for the same tenant share
  // one DB read (and a burst can't stampede the store).
  const cache = new Map<string, { value: Promise<ResolvedTenantPolicy>; expiresAt: number }>();
  // Last successfully-resolved policy per key, so a version that later fails to
  // load (bad parse during a rolling upgrade, transient DB error) degrades to the
  // last-good policy instead of 500ing every request for this tenant. Only REAL
  // active versions are stored here (never the shared fallback), so a caller
  // spraying arbitrary X-Modelgov-Tenant values — which have no active version —
  // can't populate it; and it is bounded to maxEntries like the main cache.
  const lastGood = new Map<string, ResolvedTenantPolicy>();

  function rememberLastGood(tenantId: string, resolved: ResolvedTenantPolicy): void {
    lastGood.set(tenantId, resolved);
    // Bound it the same way as the main cache (oldest-insertion eviction) so a
    // large/hostile tenant space can't grow it without limit.
    while (lastGood.size > maxEntries) {
      const oldest = lastGood.keys().next().value;
      if (oldest === undefined) break;
      lastGood.delete(oldest);
    }
  }

  async function load(tenantId: string): Promise<ResolvedTenantPolicy> {
    let active: Awaited<ReturnType<typeof getActiveConfigVersion>>;
    try {
      active = await getActiveConfigVersion(pool, tenantId);
    } catch (err) {
      // Serve this tenant's last-good policy if we have one — correct for the
      // tenant, just stale; self-heals on the next TTL re-read.
      const lg = lastGood.get(tenantId);
      if (lg) {
        log?.error({ err, tenantId }, "active policy version failed to load; serving last-good policy");
        return lg;
      }
      // No last-good for this tenant — distinguish the failure:
      //  - PARSE/validation error: the stored version is bad (e.g. newer-schema
      //    version reaching an older replica mid-rollout). Fall back to the boot
      //    baseline rather than hard-fail the tenant.
      //  - READ error (DB down / connection or statement timeout): FAIL CLOSED.
      //    Serving the boot/file fallback could evaluate this tenant's requests
      //    against a MORE PERMISSIVE policy, so rethrow (the request errors out).
      //    Self-heals once the store is reachable again.
      if (err instanceof PolicyConfigError) {
        log?.error({ err, tenantId }, "active policy version failed to PARSE; serving boot fallback (no last-good)");
        return fallback;
      }
      log?.error({ err, tenantId }, "policy store read failed and no last-good policy for tenant; failing closed");
      throw err;
    }
    if (!active) {
      // No active version for this tenant — return the shared fallback but do NOT
      // store it in lastGood (that's the unbounded-growth vector for unknown/
      // attacker-chosen tenant ids, which all land here).
      return fallback;
    }
    const resolved: ResolvedTenantPolicy = {
      config: resolveConfig(active.config),
      policyMeta: { configHash: active.record.checksum, policyVersion: active.record.id },
    };
    rememberLastGood(tenantId, resolved);
    return resolved;
  }

  // Evict expired entries, then oldest-inserted, to keep the cache bounded even
  // when attacker-chosen tenant headers produce many distinct keys.
  function evictIfNeeded(): void {
    if (cache.size < maxEntries) return;
    const t = now();
    for (const [k, v] of cache) {
      if (v.expiresAt <= t) cache.delete(k);
    }
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    async resolve(tenantId): Promise<ResolvedTenantPolicy> {
      const key = keyFor(tenantId);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.value;

      evictIfNeeded();
      const entry: { value: Promise<ResolvedTenantPolicy>; expiresAt: number } = {
        value: Promise.resolve(fallback), // placeholder, replaced below
        expiresAt: now() + ttl,
      };
      // load() no longer rejects (it degrades to last-good/fallback), so a cached
      // entry is always a usable policy. Keep the defensive evict-on-reject in case
      // resolveConfig throws synchronously.
      entry.value = load(key).catch((err) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
      cache.set(key, entry);
      return entry.value;
    },
    invalidate(tenantId): void {
      cache.delete(keyFor(tenantId));
    },
    clear(): void {
      cache.clear();
    },
  };
}
