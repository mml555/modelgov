import type { RequestContext } from "../../plugins/requestContext";
import {
  checkProjectScope,
  checkTenantScope,
  checkUserIdAllowedIfPresent,
  checkUserTypeAllowedIfPresent,
  resolveProjectScope,
  resolveTenantScope,
} from "../authz/scope";
import type { UsageQuery } from "./service";

export interface AuthorizedUsageQuery extends UsageQuery {
  /** Project partition for budget_counters (user_daily / feature_monthly). */
  budgetProjectId: string;
  /** When set, recent request stats are filtered to this project. */
  projectScope?: string;
  /** When set, request-log aggregates are filtered to this tenant. */
  tenantScope?: string;
  includeGlobal: boolean;
}

export function authorizeUsageQuery(
  ctx: RequestContext,
  query: UsageQuery,
  defaultProjectId: string,
):
  | { ok: true; value: AuthorizedUsageQuery }
  | { ok: false; status: number; code: string; message: string } {
  const tenantScoped = Boolean(ctx.projectId);

  const userDenial = checkUserIdAllowedIfPresent(ctx, query.userId);
  if (userDenial) return deny(userDenial.status, userDenial.code, userDenial.message);

  const projectDenial = checkProjectScope(ctx, query.projectId);
  if (projectDenial) return deny(projectDenial.status, projectDenial.code, projectDenial.message);

  const tenantDenial = checkTenantScope(ctx);
  if (tenantDenial) return deny(tenantDenial.status, tenantDenial.code, tenantDenial.message);

  if (tenantScoped && query.userId === undefined && query.feature === undefined) {
    return deny(
      403,
      "usage_scope_required",
      "Tenant-scoped API keys must provide userId or feature on usage queries",
    );
  }

  const budgetProjectId = resolveProjectScope(ctx, query.projectId, defaultProjectId)!;

  return {
    ok: true,
    value: {
      ...query,
      budgetProjectId,
      projectScope: resolveProjectScope(ctx, query.projectId),
      tenantScope: resolveTenantScope(ctx),
      includeGlobal: !tenantScoped,
    },
  };
}

export function authorizeUsageSummary(
  ctx: RequestContext,
  query: { feature?: string; userType?: string; projectId?: string },
  defaultProjectId: string,
):
  | { ok: true; projectScope?: string; tenantScope?: string }
  | { ok: false; status: number; code: string; message: string } {
  const projectDenial = checkProjectScope(ctx, query.projectId);
  if (projectDenial) return deny(projectDenial.status, projectDenial.code, projectDenial.message);

  const tenantDenial = checkTenantScope(ctx);
  if (tenantDenial) return deny(tenantDenial.status, tenantDenial.code, tenantDenial.message);

  const userTypeDenial = checkUserTypeAllowedIfPresent(ctx, query.userType);
  if (userTypeDenial) {
    return deny(userTypeDenial.status, userTypeDenial.code, userTypeDenial.message);
  }

  return {
    ok: true,
    projectScope: resolveProjectScope(ctx, query.projectId, defaultProjectId),
    tenantScope: resolveTenantScope(ctx),
  };
}

function deny(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message };
}
