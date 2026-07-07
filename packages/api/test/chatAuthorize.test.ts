import { describe, expect, it } from "vitest";
import { authorizeChatInput } from "../src/modules/chat/authorize";
import type { RequestContext } from "../src/plugins/requestContext";
import type { ChatInput } from "../src/modules/chat/types";

const baseInput: ChatInput = {
  userId: "user_1",
  userType: "logged_in",
  feature: "support_chat",
  messages: [{ role: "user", content: "hi" }],
};

function ctx(patch: Omit<RequestContext, "requestId">): RequestContext {
  return { requestId: "req_test", ...patch };
}

// Extracting authorization out of the route makes these rules unit-testable
// without booting a server — the point of the layering split.
describe("authorizeChatInput", () => {
  it("allows and defaults project/environment from the key", () => {
    const context = ctx({
      principalName: "k",
      permissions: ["chat:create"],
      projectId: "proj_a",
      environment: "prod",
    });
    const res = authorizeChatInput(context, baseInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.projectId).toBe("proj_a");
      expect(res.value.environment).toBe("prod");
    }
  });

  it("denies when the key lacks chat:create", () => {
    const context = ctx({ principalName: "k", permissions: ["usage:read"] });
    const res = authorizeChatInput(context, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe("forbidden");
    }
  });

  it("denies a project mismatch", () => {
    const context = ctx({ principalName: "k", permissions: ["chat:create"], projectId: "proj_a" });
    const res = authorizeChatInput(context, { ...baseInput, projectId: "proj_b" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("project_mismatch");
  });

  it("denies a user-type outside the key's allowlist", () => {
    const context = ctx({
      principalName: "k",
      permissions: ["chat:create"],
      allowedUserTypes: ["admin"],
    });
    const res = authorizeChatInput(context, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("user_type_forbidden");
  });

  it("denies a userId outside the key's allowlist", () => {
    const context = ctx({
      principalName: "k",
      permissions: ["chat:create"],
      allowedUserIds: ["user_2"],
    });
    const res = authorizeChatInput(context, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("user_forbidden");
  });
});
