import type { PolicyDecisionKind } from "@ai-guard/policy-engine";
import type { ExplainResponse } from "./types";

/** Human-readable policy explanation for CLI output and API `summary`. */
export function formatExplainSummary(body: ExplainResponse): string {
  const lines: string[] = [
    `Decision: ${body.decision}`,
  ];

  if (body.reason) {
    lines.push(`Reason: ${body.reason}`);
  }

  lines.push(
    `Requested: ${body.requested.modelClass} (${body.requested.feature} / ${body.requested.userType})`,
  );

  if (body.requested.modelClass !== body.resolved.modelClass) {
    lines.push(`Resolved class: ${body.resolved.modelClass}`);
  }

  lines.push(`Model: ${body.resolved.model}`);
  if (body.resolved.fallbackModel) {
    lines.push(`Fallback: ${body.resolved.fallbackModel}`);
  }

  lines.push(
    `Budget remaining: $${body.budget.remaining.userDailyUsd.toFixed(4)} today` +
      ` (${body.budget.dailyRequestsRemaining}/${body.budget.dailyRequestLimit} requests)`,
  );

  if (body.budget.remaining.featureMonthlyUsd !== null) {
    lines.push(
      `Feature monthly: $${body.budget.remaining.featureMonthlyUsd.toFixed(4)} remaining`,
    );
  }

  if (body.budget.remaining.globalMonthlyUsd !== null) {
    lines.push(
      `Global monthly: $${body.budget.remaining.globalMonthlyUsd.toFixed(4)} remaining`,
    );
  }

  lines.push(
    `Safety: ${body.safety.preset} (pii: ${body.safety.pii}, injection: ${body.safety.promptInjection})`,
  );
  lines.push(`Est. cost: $${body.cost.estimatedUsd.toFixed(6)}`);

  if (!body.wouldCallModel) {
    lines.push("→ Request would be blocked before calling the model.");
  } else if (body.decision === "degrade") {
    lines.push("→ Request would run on a downgraded model class.");
  } else if (body.decision === "fallback") {
    lines.push("→ Primary failed; request would use the fallback model.");
  } else {
    lines.push("→ Request would proceed to the model.");
  }

  return lines.join("\n");
}

export function wouldCallModel(decision: PolicyDecisionKind): boolean {
  return decision !== "block";
}
