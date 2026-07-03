import { parseConfigObject } from "@modelgov/policy-engine";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createOidcVerifier } from "../src/modules/authz/oidc";
import {
  KNOWN_PERMISSIONS,
  permissionsForRoles,
  ROLE_PERMISSIONS,
} from "../src/modules/authz/roles";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { mockPool } from "./mockPool";

const ISSUER = "https://idp.example.com/";
const AUDIENCE = "modelgov";

let privateKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.alg = "RS256";
  jwk.kid = "test-key";
  jwks = createLocalJWKSet({ keys: [jwk] });
});

interface MintOpts {
  issuer?: string;
  audience?: string;
  subject?: string;
  expEpoch?: number;
}

async function mint(claims: Record<string, unknown>, opts: MintOpts = {}): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(opts.subject ?? "alice");
  jwt.setExpirationTime(opts.expEpoch ?? "1h");
  return jwt.sign(privateKey);
}

describe("RBAC roles", () => {
  it("expands a role to its permission bundle", () => {
    expect(permissionsForRoles(["viewer"]).sort()).toEqual(
      ["requests:read", "usage:read"].sort(),
    );
  });

  it("owner has every known permission", () => {
    expect(new Set(permissionsForRoles(["owner"]))).toEqual(new Set(KNOWN_PERMISSIONS));
  });

  it("unions multiple roles and dedups", () => {
    const perms = permissionsForRoles(["viewer", "key-admin"]);
    expect(perms).toContain("keys:admin");
    expect(perms).toContain("usage:read");
    // usage:read appears in both roles but only once.
    expect(perms.filter((p) => p === "usage:read")).toHaveLength(1);
  });

  it("ignores unknown roles", () => {
    expect(permissionsForRoles(["not-a-role"])).toEqual([]);
  });

  it("key-admin cannot write policy (least privilege)", () => {
    expect(ROLE_PERMISSIONS["key-admin"]).not.toContain("policy:write");
  });
});

describe("OIDC verifier", () => {
  function verifier(overrides: Partial<Parameters<typeof createOidcVerifier>[0]> = {}) {
    return createOidcVerifier(
      { issuer: ISSUER, jwksUri: "https://unused.example/jwks", audience: AUDIENCE, ...overrides },
      jwks,
    );
  }

  it("verifies a valid token and maps roles to permissions", async () => {
    const token = await mint({ roles: ["owner"] });
    const principal = await verifier().verify(token);
    expect(principal?.name).toBe("oidc:alice");
    expect(principal?.permissions).toContain("keys:admin");
    expect(principal?.permissions).toContain("chat:create");
  });

  it("maps a viewer to read-only permissions", async () => {
    const token = await mint({ roles: ["viewer"] });
    const principal = await verifier().verify(token);
    expect([...(principal?.permissions ?? [])].sort()).toEqual(
      ["requests:read", "usage:read"].sort(),
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await mint({ roles: ["owner"] }, { audience: "someone-else" });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects a token from the wrong issuer", async () => {
    const token = await mint({ roles: ["owner"] }, { issuer: "https://evil.example/" });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mint({ roles: ["owner"] }, { expEpoch: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects a garbage token", async () => {
    expect(await verifier().verify("a.b.c")).toBeNull();
  });

  it("applies a role map from IdP groups to Modelgov roles", async () => {
    const token = await mint({ roles: ["ldap-ai-admins"] });
    const principal = await verifier({ roleMap: { "ldap-ai-admins": "owner" } }).verify(token);
    expect(principal?.permissions).toContain("keys:admin");
  });

  it("reads roles from a custom claim and space-delimited string", async () => {
    const token = await mint({ groups: "viewer key-admin" });
    const principal = await verifier({ rolesClaim: "groups" }).verify(token);
    expect(principal?.permissions).toContain("keys:admin");
    expect(principal?.permissions).toContain("usage:read");
  });

  it("returns an authenticated principal with no permissions when no roles map", async () => {
    const token = await mint({ roles: ["nothing-useful"] });
    const principal = await verifier().verify(token);
    expect(principal?.permissions).toEqual([]);
  });
});

describe("operator SSO integration", () => {
  const config = parseConfigObject({
    project: { name: "test", environment: "test" },
    budgets: {
      global: { monthly_usd: 100, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
    },
    features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    safety: { preset: "dev" },
  });

  function app() {
    return buildServer({
      config,
      pool: mockPool() as never,
      litellm: { chat: async () => { throw new Error("unreached"); } },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "static-key",
      jwtVerifier: createOidcVerifier(
        { issuer: ISSUER, jwksUri: "https://unused.example/jwks", audience: AUDIENCE },
        jwks,
      ),
    });
  }

  const validChat = {
    userId: "u1",
    userType: "logged_in",
    feature: "support_chat",
    messages: [{ role: "user", content: "hi" }],
  };

  it("rejects a JWT-shaped token that fails verification", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer aaa.bbb.ccc" },
      payload: validChat,
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticates an operator JWT but denies chat without chat:create", async () => {
    const token = await mint({ roles: ["viewer"] });
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: validChat,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("lets an owner JWT past auth to route validation", async () => {
    const token = await mint({ roles: ["owner"] });
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("still accepts static API keys alongside SSO", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer static-key" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
