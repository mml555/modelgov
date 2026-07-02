import { describe, expect, it } from "vitest";
import {
  assertDeployProfilePosture,
  deployProfileChecks,
  profileEnvFlags,
  resolveDeployProfile,
} from "../src/deployProfiles";

describe("resolveDeployProfile", () => {
  it("uses explicit AI_GUARD_DEPLOY_PROFILE", () => {
    expect(resolveDeployProfile({ AI_GUARD_DEPLOY_PROFILE: "selfhost" })).toBe("selfhost");
    expect(resolveDeployProfile({ AI_GUARD_DEPLOY_PROFILE: "multitenant" })).toBe("multitenant");
  });

  it("infers multitenant from MULTI_TENANT_POLICY", () => {
    expect(resolveDeployProfile({ MULTI_TENANT_POLICY: "true" })).toBe("multitenant");
  });
});

describe("profileEnvFlags", () => {
  it("selfhost keeps flat single-tenant defaults", () => {
    expect(profileEnvFlags("selfhost")).toMatchObject({
      HIERARCHICAL_BUDGETS: "false",
      MULTI_TENANT_POLICY: "false",
      POLICY_STORE_ENABLED: "false",
    });
  });

  it("multitenant enables policy store and RLS but not hierarchy by default", () => {
    expect(profileEnvFlags("multitenant")).toMatchObject({
      HIERARCHICAL_BUDGETS: "false",
      MULTI_TENANT_POLICY: "true",
      POLICY_STORE_ENABLED: "true",
      DB_RLS_ENABLED: "true",
    });
  });
});

describe("deployProfileChecks", () => {
  it("fails multitenant profile when RLS is off in production", () => {
    const checks = deployProfileChecks(
      {
        AI_GUARD_DEPLOY_PROFILE: "multitenant",
        AI_GUARD_PRODUCTION: "true",
        POLICY_STORE_ENABLED: "true",
        MULTI_TENANT_POLICY: "true",
        DB_RLS_ENABLED: "false",
      },
      { production: true },
    );
    expect(checks.some((c) => c.code === "multitenant_rls" && c.severity === "fail")).toBe(true);
  });

  it("warns selfhost when hierarchical budgets are enabled", () => {
    const checks = deployProfileChecks({
      AI_GUARD_DEPLOY_PROFILE: "selfhost",
      HIERARCHICAL_BUDGETS: "true",
    });
    expect(checks.some((c) => c.code === "selfhost_hierarchical")).toBe(true);
  });

  it("assertDeployProfilePosture throws on production multitenant misconfig", () => {
    expect(() =>
      assertDeployProfilePosture({
        AI_GUARD_PRODUCTION: "true",
        AI_GUARD_DEPLOY_PROFILE: "multitenant",
        POLICY_STORE_ENABLED: "true",
        MULTI_TENANT_POLICY: "true",
        DB_RLS_ENABLED: "false",
      }),
    ).toThrow(/Deploy profile posture failed/);
  });
});
