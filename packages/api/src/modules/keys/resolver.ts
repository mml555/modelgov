import type { Pool } from "pg";
import type { ResolvedPrincipal } from "../../plugins/auth";
import { findActiveApiKeyByToken, hashApiKey } from "./repo";

/**
 * Resolves API keys from the Postgres key store, with a short TTL cache so the
 * auth hot path doesn't hit the DB on every request. Cache TTL bounds how long a
 * revoked/rotated key can still be accepted — keep it low (default 10s) so
 * revocation takes effect within seconds across all replicas.
 *
 * The cache is keyed by the SHA-256 of the token (never the raw secret), and
 * negative results are cached briefly and capped so a flood of distinct invalid
 * tokens can't grow memory unbounded or hammer the DB.
 */
export interface DbKeyResolverOptions {
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  maxCacheEntries?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface CacheEntry {
  principal: ResolvedPrincipal | null;
  expiresAt: number;
}

export interface DbKeyResolver {
  resolve(token: string): Promise<ResolvedPrincipal | null>;
  /** Drop a cached entry immediately (e.g. right after revoke/rotate). */
  invalidate(token: string): void;
  clear(): void;
}

export function createDbKeyResolver(
  pool: Pool,
  options: DbKeyResolverOptions = {},
): DbKeyResolver {
  const ttl = options.cacheTtlMs ?? 10_000;
  const negativeTtl = options.negativeCacheTtlMs ?? 5_000;
  const maxEntries = options.maxCacheEntries ?? 5_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  function set(hash: string, principal: ResolvedPrincipal | null): void {
    // Simple bound: once full, clear the map. Cheap and correct; entries are
    // cheap to repopulate and TTLs are short.
    if (cache.size >= maxEntries) cache.clear();
    cache.set(hash, {
      principal,
      expiresAt: now() + (principal ? ttl : negativeTtl),
    });
  }

  return {
    async resolve(token: string): Promise<ResolvedPrincipal | null> {
      if (!token) return null;
      const hash = hashApiKey(token);
      const cached = cache.get(hash);
      if (cached && cached.expiresAt > now()) return cached.principal;

      const active = await findActiveApiKeyByToken(pool, token);
      const principal: ResolvedPrincipal | null = active
        ? {
            name: active.name,
            // Stable id (the key uuid) for controls that must identify the
            // operator regardless of its mutable display name.
            principalId: active.id,
            projectId: active.projectId,
            environment: active.environment,
            allowedUserTypes: active.allowedUserTypes,
            allowedUserIds: active.allowedUserIds,
            permissions: active.permissions,
            tenantId: active.tenantId,
            budgetNodeId: active.budgetNodeId,
          }
        : null;
      set(hash, principal);
      return principal;
    },
    invalidate(token: string): void {
      cache.delete(hashApiKey(token));
    },
    clear(): void {
      cache.clear();
    },
  };
}
