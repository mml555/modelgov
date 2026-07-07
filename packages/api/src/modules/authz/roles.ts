// Operator RBAC: named roles expand to permission bundles. Both API keys and
// SSO-authenticated operators ultimately carry a flat `permissions` list on the
// request context; roles are just a convenient, auditable way to assign them.
//
// Least privilege: a role grants only what its function needs. `owner` is the
// only role with write access to both keys and policy.

export const KNOWN_PERMISSIONS = [
  "chat:create",
  "usage:read",
  "requests:read",
  "keys:admin",
  "policy:read",
  "policy:write",
  // Approve/reject a proposed policy version (two-person rule). Kept distinct
  // from policy:write so the proposer and approver can be different operators.
  "policy:approve",
  "audit:read",
  "data:erase",
  "billing:write",
  // Platform capability: scope a request to another tenant via the
  // `X-Modelgov-Tenant` header. Only unbound (platform) principals can switch at
  // all, and only with this permission — without it an unbound operator (e.g. an
  // OIDC viewer) is confined to the default partition and cannot read/write other
  // tenants' data. Granted to `owner` only by default.
  "tenant:switch",
] as const;

export type Permission = (typeof KNOWN_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  // Read-only visibility into usage and the audit trail.
  viewer: ["usage:read", "requests:read"],
  // FinOps: spend + audit visibility (same reads today; a distinct role so
  // policy can diverge later and so audit shows intent).
  finops: ["usage:read", "requests:read", "audit:read", "billing:write"],
  // Manage API keys, with the reads needed to see their effect.
  "key-admin": ["keys:admin", "usage:read", "requests:read", "audit:read"],
  // Author policy without touching keys. Intentionally lacks policy:approve so
  // that enabling the two-person rule forces a distinct approver (separation of
  // duties) — a policy-admin proposes, a policy-approver signs off.
  "policy-admin": ["policy:read", "policy:write", "usage:read", "requests:read", "audit:read"],
  // Review (approve/reject) proposed policy versions without authoring them.
  "policy-approver": ["policy:read", "policy:approve", "usage:read", "requests:read", "audit:read"],
  // Full control plane.
  owner: [...KNOWN_PERMISSIONS],
};

/** Expand a set of role names into the union of their permissions. */
export function permissionsForRoles(roles: readonly string[]): string[] {
  const out = new Set<string>();
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role];
    if (perms) for (const p of perms) out.add(p);
  }
  return [...out];
}
