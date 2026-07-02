import { describe, expect, it } from "vitest";
import { authorizeUsageQuery, authorizeUsageSummary } from "../src/modules/usage/authorizeUsage";

describe("authorizeUsageQuery", () => {
  it("denies tenant-scoped keys without userId or feature", () => {
    const result = authorizeUsageQuery(
      { permissions: ["usage:read"], projectId: "tenant-a" } as never,
      {},
      "default",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("usage_scope_required");
    }
  });

  it("allows tenant-scoped keys when userId is provided", () => {
    const result = authorizeUsageQuery(
      { permissions: ["usage:read"], projectId: "tenant-a" } as never,
      { userId: "u1" },
      "default",
    );
    expect(result.ok).toBe(true);
  });
});

describe("authorizeUsageSummary", () => {
  it("denies when userType is not on the key allowlist", () => {
    const result = authorizeUsageSummary(
      {
        permissions: ["usage:read"],
        allowedUserTypes: ["logged_in"],
      } as never,
      { userType: "admin" },
      "default",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("allows summary when userType matches the key allowlist", () => {
    const result = authorizeUsageSummary(
      {
        permissions: ["usage:read"],
        allowedUserTypes: ["logged_in"],
      } as never,
      { userType: "logged_in" },
      "default",
    );
    expect(result.ok).toBe(true);
  });
});
