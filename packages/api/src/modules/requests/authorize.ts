import type { RequestContext } from "../../plugins/requestContext";
import {
  checkProjectScope,
  checkTenantScope,
  checkUserIdAllowedIfPresent,
  checkUserTypeAllowedIfPresent,
  resolveProjectScope,
  resolveTenantScope,
} from "../authz/scope";
import type { RequestListQuery } from "./types";

export interface AuthorizedRequestQuery extends RequestListQuery {
  projectScope?: string;
  tenantScope?: string;
}

export function authorizeRequestList(
  ctx: RequestContext,
  query: RequestListQuery,
  defaultProjectId: string,
):
  | { ok: true; value: AuthorizedRequestQuery }
  | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("requests:read")) {
    return deny(403, "forbidden", "API key is not permitted to read requests");
  }

  const userDenial = checkUserIdAllowedIfPresent(ctx, query.userId);
  if (userDenial) return deny(userDenial.status, userDenial.code, userDenial.message);

  const projectDenial = checkProjectScope(ctx, query.projectId);
  if (projectDenial) return deny(projectDenial.status, projectDenial.code, projectDenial.message);

  const tenantDenial = checkTenantScope(ctx);
  if (tenantDenial) return deny(tenantDenial.status, tenantDenial.code, tenantDenial.message);

  const userTypeDenial = checkUserTypeAllowedIfPresent(ctx, query.userType);
  if (userTypeDenial) return deny(userTypeDenial.status, userTypeDenial.code, userTypeDenial.message);

  return {
    ok: true,
    value: {
      ...query,
      projectScope: resolveProjectScope(ctx, query.projectId, defaultProjectId),
      tenantScope: resolveTenantScope(ctx),
    },
  };
}

export function authorizeRequestShow(
  ctx: RequestContext,
  projectId?: string,
):
  | { ok: true; projectScope?: string; tenantScope?: string }
  | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("requests:read")) {
    return deny(403, "forbidden", "API key is not permitted to read requests");
  }

  const projectDenial = checkProjectScope(ctx, projectId);
  if (projectDenial) return deny(projectDenial.status, projectDenial.code, projectDenial.message);

  const tenantDenial = checkTenantScope(ctx);
  if (tenantDenial) return deny(tenantDenial.status, tenantDenial.code, tenantDenial.message);

  return {
    ok: true,
    projectScope: resolveProjectScope(ctx, projectId),
    tenantScope: resolveTenantScope(ctx),
  };
}

function deny(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message };
}
