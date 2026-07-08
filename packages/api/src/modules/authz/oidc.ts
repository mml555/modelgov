import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ResolvedPrincipal } from "../../plugins/auth";
import { permissionsForRoles } from "./roles";

/**
 * OIDC/JWT operator authentication. A corporate IdP issues an access/ID token;
 * we verify its signature against the IdP's JWKS, enforce issuer/audience/exp,
 * then map the token's roles/groups claim to Modelgov operator roles and expand
 * those to permissions. Application traffic keeps using API keys — this path is
 * for humans/automation acting on the control plane.
 */
export interface OidcConfig {
  issuer: string;
  jwksUri: string;
  /** Expected `aud`. Recommended; omit only if your IdP can't scope audiences. */
  audience?: string;
  /** Claim holding roles/groups. Default "roles". */
  rolesClaim?: string;
  /**
   * Map an IdP role/group value to one or more Modelgov roles. When omitted, the
   * claim values are treated as Modelgov role names directly (unknown ones grant
   * nothing).
   */
  roleMap?: Record<string, string | string[]>;
  /** Claim used as the principal display name. Default "sub". */
  nameClaim?: string;
  /**
   * Claim holding the operator's tenant id. When set and present on the token,
   * the resulting principal is BOUND to that tenant — it is locked to that
   * tenant's data and cannot use `X-Modelgov-Tenant` to reach another (the
   * gateway ignores the header for a bound principal). Without this, every OIDC
   * operator is unbound (a platform operator), so a tenant-scoped IdP user would
   * otherwise be able to switch tenants. Leave unset for platform-only SSO.
   */
  tenantClaim?: string;
  /**
   * Accepted JWS signing algorithms. Defaults to the common asymmetric set — an
   * explicit allowlist is defense-in-depth so verification can never accept an
   * algorithm the IdP didn't intend (e.g. a symmetric alg the JWKS shouldn't key).
   */
  algorithms?: string[];
}

/** Asymmetric signing algorithms accepted for operator JWTs by default. */
const DEFAULT_JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "EdDSA",
];

export interface OidcVerifier {
  verify(token: string): Promise<ResolvedPrincipal | null>;
}

function extractRoles(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((v): v is string => typeof v === "string");
  if (typeof claim === "string") return claim.split(/[\s,]+/).filter(Boolean);
  return [];
}

function mapRoles(rawRoles: string[], roleMap?: OidcConfig["roleMap"]): string[] {
  if (!roleMap) return rawRoles;
  const out = new Set<string>();
  for (const raw of rawRoles) {
    const mapped = roleMap[raw];
    if (typeof mapped === "string") out.add(mapped);
    else if (Array.isArray(mapped)) for (const m of mapped) out.add(m);
  }
  return [...out];
}

/**
 * @param getKey Injectable key resolver (jose JWKSet). Defaults to a remote JWKS
 *   fetched (and cached) from `config.jwksUri`. Tests pass a local set.
 */
export function createOidcVerifier(
  config: OidcConfig,
  getKey?: JWTVerifyGetKey,
): OidcVerifier {
  const jwks = getKey ?? createRemoteJWKSet(new URL(config.jwksUri));
  const rolesClaim = config.rolesClaim ?? "roles";
  const nameClaim = config.nameClaim ?? "sub";
  const tenantClaim = config.tenantClaim;
  const algorithms = config.algorithms ?? DEFAULT_JWT_ALGORITHMS;

  return {
    async verify(token: string): Promise<ResolvedPrincipal | null> {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms,
        }));
      } catch {
        // Bad signature / expired / wrong issuer|audience → not an operator.
        return null;
      }

      const roles = mapRoles(extractRoles(payload[rolesClaim]), config.roleMap);
      const permissions = permissionsForRoles(roles);
      const name = String(payload[nameClaim] ?? payload.sub ?? "operator");
      // Bind the operator to a tenant when the configured claim is present, so a
      // tenant-scoped IdP user is locked to that tenant (and can't switch). A
      // non-string/empty claim leaves the principal unbound (platform), same as
      // when no tenant claim is configured.
      const tenantValue = tenantClaim ? payload[tenantClaim] : undefined;
      const tenantId =
        typeof tenantValue === "string" && tenantValue.trim() !== "" ? tenantValue.trim() : undefined;
      // A verified token with no mapped roles is authenticated-but-unauthorized:
      // return an empty permission set so protected routes answer 403, not 401.
      // principalId is the STABLE subject (sub) — controls like the two-person
      // approval rule key on it, not the mutable `name`/display claim.
      const sub = payload.sub ? String(payload.sub) : undefined;
      return {
        name: `oidc:${name}`,
        principalId: sub ? `oidc:${sub}` : undefined,
        permissions,
        tenantId,
      };
    },
  };
}
