import type { RequestContext } from "../../plugins/requestContext";
import type { ChatInput } from "./types";

/**
 * Leaf budget node to bill against. A node bound to the API key ALWAYS wins over
 * a body-supplied one: otherwise a key deliberately scoped to a node could name a
 * laxer sibling in its own tenant and escape its cap. Only a key that is NOT
 * node-bound may choose the node per request (still tenant-scoped downstream by
 * resolvePath, so it can never reach another tenant's tree).
 */
export function resolveBudgetNodeId(
  input: ChatInput,
  ctx: Pick<RequestContext, "budgetNodeId">,
): string | undefined {
  return ctx.budgetNodeId ?? input.budgetNodeId;
}

/** True when hierarchical budgets are enabled and a node id is present. */
export function useHierarchicalBudgets(
  hierarchicalBudgets: boolean | undefined,
  leafNodeId: string | undefined,
): leafNodeId is string {
  return Boolean(hierarchicalBudgets && leafNodeId);
}
