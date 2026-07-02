/** Infer a stable reason code from legacy error text when reason_code was not stored. */
export function inferReasonCode(
  error: string | null | undefined,
  decision: string,
): string | undefined {
  if (!error) {
    if (decision === "fallback") return "provider_fallback";
    if (decision === "degrade") return "global_budget_degraded";
    return undefined;
  }

  const lower = error.toLowerCase();
  if (error.startsWith("budget_exceeded:")) {
    const scope = error.slice("budget_exceeded:".length);
    if (scope === "user_daily") return "daily_budget_exceeded";
    if (scope === "feature_monthly") return "feature_monthly_budget_exceeded";
    if (scope === "global_monthly") return "global_monthly_budget_exceeded";
    return "daily_budget_exceeded";
  }
  if (lower.includes("not permitted")) return "model_class_not_permitted";
  if (lower.includes("daily request limit")) return "daily_request_limit_reached";
  if (lower.includes("user daily budget")) return "daily_budget_exceeded";
  if (lower.includes("feature monthly budget")) return "feature_monthly_budget_exceeded";
  if (lower.includes("global monthly budget")) return "global_monthly_budget_exceeded";
  if (lower.includes("degraded")) return "global_budget_degraded";
  if (lower.includes("prompt injection") || lower.includes("injection")) {
    return "prompt_injection_blocked";
  }
  if (lower.includes("pii")) return "pii_blocked";
  if (lower.includes("provider")) return "provider_unavailable";
  return undefined;
}

export function mapDbStatus(
  status: string,
  decision: string,
): "completed" | "blocked" | "safety_blocked" | "error" {
  if (status === "ok") return "completed";
  if (status === "safety_blocked") return "safety_blocked";
  if (status === "failed" && decision === "fallback") return "error";
  return "blocked";
}

export function apiStatusToDbStatus(
  status: "completed" | "blocked" | "safety_blocked" | "error",
): string[] {
  switch (status) {
    case "completed":
      return ["ok"];
    case "safety_blocked":
      return ["safety_blocked"];
    case "blocked":
      return ["failed"];
    case "error":
      return ["failed"];
    default:
      return [];
  }
}

export function providerFromModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}
