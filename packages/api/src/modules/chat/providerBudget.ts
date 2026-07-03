import type { AiRequest, PolicyDecision } from "@modelgov/policy-engine";
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
  tenantId?: string;
  billing?: import("../billing/service").BillingService;
  skipInternalBudget?: boolean;
  /** Safety/classifier spend already incurred — booked from credits on release. */
  safetyCostUsd?: number;
}): ProviderBudgetCtx {
  let reservedUsd = args.initialReservedUsd;
  const { pool, aiRequest, decision, now, leaseId, tenantId, billing, skipInternalBudget, safetyCostUsd } = args;

  const incur: IncurFn = (costUsd) =>
    recordIncurredCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      costUsd,
      caps: decision.reservationCaps,
      now,
      tenantId,
    });

  return {
    getReservedUsd: () => reservedUsd,
    setReservedUsd: (usd) => {
      reservedUsd = usd;
    },
    incur,
    release: async () => {
      if (!skipInternalBudget && leaseId) {
        await releaseBudget(pool, {
          projectId: aiRequest.projectId,
          userId: aiRequest.userId,
          feature: aiRequest.feature,
          estimatedCostUsd: reservedUsd,
          estimatedTokens: decision.estimatedTokens,
          caps: decision.reservationCaps,
          now,
          leaseId,
          tenantId,
        });
      }
      if (billing?.usesCredits() && reservedUsd > 0) {
        const incurred = safetyCostUsd ?? 0;
        if (incurred > 0) {
          // Book the incurred safety spend from credits and release the rest —
          // a full refund would give back credits for work already paid for.
          await billing.settleCredits(tenantId ?? "", aiRequest.userId, reservedUsd, incurred);
        } else {
          await billing.releaseCredits(tenantId ?? "", aiRequest.userId, reservedUsd);
        }
      }
    },
    topUp: async (additionalUsd): Promise<TopUpOutcome> => {
      // credits_only skips the internal budget ledger, so there is no lease to
      // release a top-up against — writing reserved_usd here would leak it.
      // The credit wallet is the ledger in that mode.
      if (skipInternalBudget) return { ok: true };
      const result = await topUpBudget(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        additionalCostUsd: additionalUsd,
        caps: decision.reservationCaps,
        now,
        leaseId,
        tenantId,
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
