import { NextResponse } from "next/server";
import {
  AiGuardError,
  PolicyBlockedError,
  SafetyBlockedError,
  type ChatMessage,
  type FeatureName,
  type UserTypeName,
} from "@ai-guard/sdk";
import { ai } from "@/lib/ai-guard";

// Demo "tiers" map to Ai-Guard user types. In a real app these come from your
// auth/session — Ai-Guard only ever receives userId + userType.
const TIERS: UserTypeName[] = ["anonymous", "logged_in", "admin"];
const FEATURES: FeatureName[] = ["support_chat", "notes_helper"];

interface Body {
  messages: ChatMessage[];
  userType: UserTypeName;
  feature: FeatureName;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as Partial<Body>;
  const userType = TIERS.includes(body.userType as UserTypeName) ? (body.userType as UserTypeName) : "anonymous";
  const feature = FEATURES.includes(body.feature as FeatureName) ? (body.feature as FeatureName) : "support_chat";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }

  try {
    // Ai-Guard checks budget / tokens / model access / safety BEFORE the model runs.
    const res = await ai.chat({
      userId: `demo-${userType}`,
      userType,
      feature,
      messages,
    });
    return NextResponse.json({
      ok: true,
      reply: res.message.content,
      meta: {
        model: res.model,
        provider: res.provider,
        decision: res.decision,
        reason: res.reason ?? null,
        usage: res.usage,
        cost: res.cost,
        budgetRemaining: res.budgetRemaining,
        safety: res.safety,
        requestId: res.requestId,
      },
    });
  } catch (err) {
    if (err instanceof SafetyBlockedError) {
      return NextResponse.json(
        { ok: false, kind: "safety", reasonCode: err.reasonCode ?? "safety_blocked", message: "Blocked by safety (PII or prompt injection)." },
        { status: 400 },
      );
    }
    if (err instanceof PolicyBlockedError) {
      return NextResponse.json(
        {
          ok: false,
          kind: "policy",
          reasonCode: err.reasonCode ?? "policy_blocked",
          message: humanizeReason(err.reasonCode),
          budgetRemaining: err.budgetRemaining ?? null,
          auditRequestId: err.auditRequestId ?? null,
        },
        { status: 429 },
      );
    }
    if (err instanceof AiGuardError && err.status === 503) {
      return NextResponse.json({ ok: false, kind: "unavailable", message: "A safety backend is unavailable." }, { status: 503 });
    }
    console.error("ai-guard request failed", err);
    return NextResponse.json({ ok: false, kind: "error", message: "Upstream error." }, { status: 502 });
  }
}

function humanizeReason(code?: string): string {
  switch (code) {
    case "daily_budget_exceeded": return "Daily spend limit reached for this tier.";
    case "daily_request_limit_reached": return "Daily request limit reached for this tier.";
    case "daily_token_limit_reached": return "Daily token limit reached for this tier.";
    case "feature_monthly_budget_exceeded": return "This feature's monthly budget is exhausted.";
    case "feature_monthly_token_limit_reached": return "This feature's monthly token limit is reached.";
    case "global_monthly_budget_exceeded": return "The global monthly budget hard stop was hit.";
    case "global_monthly_token_limit_reached": return "The global monthly token limit was hit.";
    case "model_class_not_permitted": return "This tier isn't allowed to use that model class.";
    default: return "Blocked by policy.";
  }
}
