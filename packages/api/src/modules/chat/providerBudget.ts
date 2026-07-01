import type { AiRequest, PolicyDecision } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import {
  recordIncurredPathCost,
  releasePath,
  type BudgetNode,
  type PathReservation,
} from "../budgets/repo";
import {
  recordIncurredCost,
  releaseBudget,
  topUpBudget,
  type BudgetScope,
} from "../usage/repo";
import type { IncurFn, ProviderBudgetCtx, TopUpOutcome } from "./lifecycle";

/** Flat-path budget context for the provider-execution phase (post-reserve). */
export function createFlatProviderBudget(args: {
  pool: Pool;
  aiRequest: AiRequest;
  decision: PolicyDecision;
  now: Date;
  leaseId?: string;
  initialReservedUsd: number;
}): ProviderBudgetCtx {
  let reservedUsd = args.initialReservedUsd;
  const { pool, aiRequest, decision, now, leaseId } = args;

  const incur: IncurFn = (costUsd) =>
    recordIncurredCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      costUsd,
      caps: decision.reservationCaps,
      now,
    });

  return {
    getReservedUsd: () => reservedUsd,
    setReservedUsd: (usd) => {
      reservedUsd = usd;
    },
    incur,
    release: () =>
      releaseBudget(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        estimatedCostUsd: reservedUsd,
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId,
      }),
    topUp: async (additionalUsd): Promise<TopUpOutcome> => {
      const result = await topUpBudget(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        additionalCostUsd: additionalUsd,
        caps: decision.reservationCaps,
        now,
        leaseId,
      });
      return {
        ok: result.ok,
        failedScope: result.failedScope as BudgetScope | undefined,
      };
    },
  };
}

/** Hierarchical-path budget context for the provider-execution phase (post-reserve). */
export function createHierarchicalProviderBudget(args: {
  pool: Pool;
  nodes: BudgetNode[];
  now: Date;
  shardKey: string;
  held: PathReservation;
  initialReservedUsd: number;
}): ProviderBudgetCtx {
  let reservedUsd = args.initialReservedUsd;
  const { pool, nodes, now, shardKey, held } = args;

  return {
    getReservedUsd: () => reservedUsd,
    setReservedUsd: (usd) => {
      reservedUsd = usd;
    },
    incur: (costUsd) => recordIncurredPathCost(pool, nodes, { costUsd, now, shardKey }),
    release: () => releasePath(pool, held),
    // No topUp: a pricier fallback settles truthfully against the path hold.
  };
}
