import { describe, expect, it } from "vitest";
import { evaluateBudgetPath, type BudgetPathNode } from "../src/budgetPath";

function node(over: Partial<BudgetPathNode> & { id: string }): BudgetPathNode {
  return {
    kind: "node",
    name: over.id,
    capUsd: null,
    requestCap: null,
    usedUsd: 0,
    reservedUsd: 0,
    requestsUsed: 0,
    ...over,
  };
}

describe("evaluateBudgetPath", () => {
  it("allows when every capped node has headroom", () => {
    const d = evaluateBudgetPath({
      path: [
        node({ id: "org", kind: "org", capUsd: 100, usedUsd: 10, reservedUsd: 5 }),
        node({ id: "user", kind: "user", capUsd: 1, usedUsd: 0.1 }),
      ],
      estimatedCostUsd: 0.2,
    });
    expect(d.decision).toBe("allow");
    expect(d.remaining.find((r) => r.nodeId === "org")?.usdRemaining).toBeCloseTo(85, 6);
    expect(d.remaining.find((r) => r.nodeId === "user")?.usdRemaining).toBeCloseTo(0.9, 6);
  });

  it("blocks on the outermost breaching node (org before user)", () => {
    const d = evaluateBudgetPath({
      path: [
        node({ id: "org", kind: "org", capUsd: 1, usedUsd: 0.9 }),
        node({ id: "user", kind: "user", capUsd: 0.001, usedUsd: 0 }),
      ],
      estimatedCostUsd: 0.2,
    });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("node_budget_exceeded");
    expect(d.failedNodeId).toBe("org"); // outermost, even though user would also fail
    expect(d.reason).toMatch(/org/);
  });

  it("treats used + reserved + estimate <= cap as allowed (boundary)", () => {
    const at = evaluateBudgetPath({
      path: [node({ id: "n", capUsd: 1, usedUsd: 0.5, reservedUsd: 0.3 })],
      estimatedCostUsd: 0.2, // 0.5 + 0.3 + 0.2 == 1.0 → allowed
    });
    expect(at.decision).toBe("allow");
    const over = evaluateBudgetPath({
      path: [node({ id: "n", capUsd: 1, usedUsd: 0.5, reservedUsd: 0.3 })],
      estimatedCostUsd: 0.2001, // just over → blocked
    });
    expect(over.decision).toBe("block");
  });

  it("enforces request caps with the request delta", () => {
    const d = evaluateBudgetPath({
      path: [node({ id: "team", kind: "team", requestCap: 5, requestsUsed: 5 })],
      estimatedCostUsd: 0,
    });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("node_request_limit_reached");
    expect(d.remaining[0]?.requestsRemaining).toBe(0);
  });

  it("never blocks on uncapped nodes and reports null remaining", () => {
    const d = evaluateBudgetPath({
      path: [node({ id: "root" }), node({ id: "leaf" })],
      estimatedCostUsd: 999,
    });
    expect(d.decision).toBe("allow");
    expect(d.remaining.every((r) => r.usdRemaining === null && r.requestsRemaining === null)).toBe(true);
  });

  it("allows an empty path (no caps to satisfy)", () => {
    expect(evaluateBudgetPath({ path: [], estimatedCostUsd: 5 }).decision).toBe("allow");
  });

  it("respects a custom requestDelta", () => {
    const d = evaluateBudgetPath({
      path: [node({ id: "n", requestCap: 10, requestsUsed: 8 })],
      estimatedCostUsd: 0,
      requestDelta: 3, // 8 + 3 = 11 > 10
    });
    expect(d.decision).toBe("block");
  });
});
