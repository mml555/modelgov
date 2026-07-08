import type { RequestContext } from "../../plugins/requestContext";

/**
 * Shared API-key scope checks for chat, explain, usage, and requests modules.
 * Permission requirements stay per-route; project/environment/user allowlists
 * are enforced here so they can't drift across four near-copies.
 */

export type ScopeDenial = {
  ok: false;
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export function denyScope(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ScopeDenial {
  return { ok: false, status, code, message, details };
}

/** Returns a denial when the body/query project disagrees with the key's binding. */
export function checkProjectScope(
  ctx: RequestContext,
  bodyProjectId?: string,
): ScopeDenial | null {
  if (ctx.projectId && bodyProjectId && bodyProjectId !== ctx.projectId) {
    return denyScope(403, "project_mismatch", "API key is not permitted for this project");
  }
  return null;
}

/** Returns a denial when the body environment disagrees with the key's binding. */
export function checkEnvironmentScope(
  ctx: RequestContext,
  bodyEnvironment?: string,
): ScopeDenial | null {
  if (ctx.environment && bodyEnvironment && bodyEnvironment !== ctx.environment) {
    return denyScope(403, "environment_mismatch", "API key is not permitted for this environment");
  }
  return null;
}

/** Returns a denial when userType is outside the key's allowlist. */
export function checkUserTypeAllowed(
  ctx: RequestContext,
  userType: string,
): ScopeDenial | null {
  if (ctx.allowedUserTypes?.length && !ctx.allowedUserTypes.includes(userType)) {
    return denyScope(403, "user_type_forbidden", "API key is not permitted for this user type");
  }
  return null;
}

/** Returns a denial when an optional query userType is outside the allowlist. */
export function checkUserTypeAllowedIfPresent(
  ctx: RequestContext,
  userType?: string,
): ScopeDenial | null {
  if (!userType) return null;
  return checkUserTypeAllowed(ctx, userType);
}

/** Returns a denial when userId is outside the key's allowlist. */
export function checkUserIdAllowed(ctx: RequestContext, userId: string): ScopeDenial | null {
  if (ctx.allowedUserIds?.length && !ctx.allowedUserIds.includes(userId)) {
    return denyScope(403, "user_forbidden", "API key is not permitted for this user");
  }
  return null;
}

/** Returns a denial when an optional query userId is outside the allowlist. */
export function checkUserIdAllowedIfPresent(
  ctx: RequestContext,
  userId?: string,
): ScopeDenial | null {
  if (!userId) return null;
  return checkUserIdAllowed(ctx, userId);
}

/** Default project/environment from the key onto a request body when absent. */
export function mergeProjectEnvironment<T extends { projectId?: string; environment?: string }>(
  ctx: RequestContext,
  body: T,
): T {
  return {
    ...body,
    projectId: ctx.projectId ?? body.projectId,
    environment: ctx.environment ?? body.environment,
  };
}

/** Resolve the effective project partition for read APIs (usage, requests). */
export function resolveProjectScope(
  ctx: RequestContext,
  queryProjectId?: string,
  defaultProjectId?: string,
): string | undefined {
  return ctx.projectId ?? queryProjectId ?? defaultProjectId;
}

/**
 * Tenant partition a read API must be confined to. A tenant-bound key resolves
 * to its own tenant; an UNBOUND key resolves to the default (untenanted)
 * partition — the empty string sentinel — NOT "no filter". This is the crux of
 * tenant isolation on reads: without it, an unbound key with a read permission
 * would see every tenant's rows in a multi-tenant deployment. In a single-tenant
 * deployment all data lives in the default partition, so the behaviour is
 * unchanged. Repos translate "" to the storage convention for the default
 * partition (`IS NULL` for request_logs, `= ''` for tenant-stamped tables).
 */
export function resolveTenantScope(ctx: RequestContext): string {
  return ctx.tenantId ?? "";
}

/**
 * Tenant partition a CONTROL-plane admin (keys, audit, emergency) must be
 * confined to. Unlike the data-plane repos, the control-plane repos treat an
 * `undefined` tenant as "no filter — every tenant". That all-tenants view must
 * be reserved for a platform operator that holds `tenant:switch`; ANY other
 * unbound operator (e.g. an OIDC `key-admin`/`viewer` with no tenant binding
 * and no OIDC_TENANT_CLAIM) must be pinned to the default (untenanted) partition
 * — the `""` sentinel — exactly like the data plane, so it cannot omit the
 * `X-Modelgov-Tenant` header to reach other tenants' keys/audit/switches.
 *
 * A bound key, or an unbound key that switched via the header, already carries a
 * concrete `ctx.tenantId` and is returned unchanged. Repos translate `""` to the
 * default-partition storage convention for their table.
 */
export function resolveControlPlaneTenant(ctx: RequestContext): string | undefined {
  if (ctx.tenantId !== undefined) return ctx.tenantId;
  return ctx.permissions?.includes("tenant:switch") ? undefined : "";
}

/**
 * Tenant-bound keys must scope usage/requests reads to their tenant. Returns a
 * denial when an explicit query tenant disagrees with the key binding.
 */
export function checkTenantScope(
  ctx: RequestContext,
  queryTenantId?: string,
): ScopeDenial | null {
  if (ctx.tenantId && queryTenantId && queryTenantId !== ctx.tenantId) {
    return denyScope(403, "tenant_mismatch", "API key is not permitted for this tenant");
  }
  return null;
}

/** Run scope checks in order; returns the first denial or null when all pass. */
export function firstScopeDenial(...checks: Array<ScopeDenial | null>): ScopeDenial | null {
  for (const denial of checks) {
    if (denial) return denial;
  }
  return null;
}
