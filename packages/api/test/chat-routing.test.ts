import { describe, expect, it } from "vitest";
import { resolveBudgetNodeId, useHierarchicalBudgets } from "../src/modules/chat/routing";

describe("chat budget routing helpers", () => {
  it("a key-bound node WINS over a body-supplied one (no cap-evading redirect)", () => {
    expect(resolveBudgetNodeId({ budgetNodeId: "body-node" } as never, { budgetNodeId: "key-node" })).toBe(
      "key-node",
    );
  });

  it("uses the body budgetNodeId only when the key is not node-bound", () => {
    expect(resolveBudgetNodeId({ budgetNodeId: "body-node" } as never, {})).toBe("body-node");
  });

  it("falls back to key budgetNodeId when the body omits one", () => {
    expect(resolveBudgetNodeId({} as never, { budgetNodeId: "key-node" })).toBe("key-node");
  });

  it("useHierarchicalBudgets requires flag and node id", () => {
    expect(useHierarchicalBudgets(true, "node-1")).toBe(true);
    expect(useHierarchicalBudgets(false, "node-1")).toBe(false);
    expect(useHierarchicalBudgets(true, undefined)).toBe(false);
  });
});
