import { describe, expect, it } from "vitest";
import {
  checkProjectScope,
  checkUserIdAllowedIfPresent,
  mergeProjectEnvironment,
  resolveProjectScope,
} from "../src/modules/authz/scope";
import type { RequestContext } from "../src/plugins/requestContext";

function ctx(patch: Omit<RequestContext, "requestId">): RequestContext {
  return { requestId: "req_test", ...patch };
}

describe("authz scope helpers", () => {
  it("checkProjectScope denies a mismatch", () => {
    const denial = checkProjectScope(ctx({ projectId: "proj_a" }), "proj_b");
    expect(denial?.code).toBe("project_mismatch");
  });

  it("mergeProjectEnvironment defaults from the key", () => {
    const merged = mergeProjectEnvironment(
      ctx({ projectId: "proj_a", environment: "prod" }),
      { projectId: undefined, environment: undefined },
    );
    expect(merged).toEqual({ projectId: "proj_a", environment: "prod" });
  });

  it("resolveProjectScope prefers the key binding", () => {
    expect(resolveProjectScope(ctx({ projectId: "key_proj" }), "query_proj", "default")).toBe(
      "key_proj",
    );
    expect(resolveProjectScope(ctx({}), "query_proj", "default")).toBe("query_proj");
  });

  it("checkUserIdAllowedIfPresent is a no-op when userId is absent", () => {
    expect(checkUserIdAllowedIfPresent(ctx({ allowedUserIds: ["u2"] }), undefined)).toBeNull();
  });
});
