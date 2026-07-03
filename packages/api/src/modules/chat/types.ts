import type {
  ModelgovConfig,
  BudgetRemaining,
} from "@modelgov/policy-engine";
import type { Pool } from "pg";
import type { LiteLLMClient } from "../../services/litellm";
import type { Observability } from "../../services/observability";
import type { SafetyGuard } from "../../services/safety";
import type { ChatMessage } from "../../types";
import type { BudgetAlertWebhookConfig } from "../usage/budgetAlerts";
import type { BillingService } from "../billing/service";

export interface ChatServiceDeps {
  config: ModelgovConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  safety: SafetyGuard;
  observability: Observability;
  budgetAlert?: BudgetAlertWebhookConfig;
  /** Config identity stamped on every request log (which policy decided). */
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string };
  log?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
  billing?: BillingService;
}

export interface ChatInput {
  userId: string;
  userType: string;
  feature: string;
  modelClass?: string;
  messages: ChatMessage[];
  /** Retrieved passages for a grounded feature (see chatBodySchema.context). */
  context?: string[];
  inputTokensEstimate?: number;
  temperature?: number;
  stream?: boolean;
  budgetNodeId?: string;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSuccess {
  ok: true;
  body: {
    message: { role: "assistant"; content: string };
    model: string;
    /** Provider of the model that actually ran (e.g. "openai", "openrouter", "azure"). */
    provider: string;
    decision: "allow" | "degrade" | "fallback";
    reason?: string;
    usage: { inputTokens: number | null; outputTokens: number | null };
    cost: { estimatedUsd: number; actualUsd: number };
    /**
     * Flat-budget headroom after this request. `null` under hierarchical
     * budgets, where the flat gates are evaluated against zero usage and the
     * node tree is the real authority — reporting a flat "remaining" there would
     * claim full headroom the caller does not actually have.
     */
    budgetRemaining: BudgetRemaining | null;
    safety: { piiMasked: boolean; injectionBlocked: boolean; grounded?: boolean };
    /** Audit log id — use with `modelgov requests show <id>`. */
    requestId: string;
  };
}

export interface ChatFailure {
  ok: false;
  status: number;
  code: string;
  message?: string;
  details: Record<string, unknown>;
  /**
   * For 5xx results: when false, the idempotency layer caches the failure
   * instead of releasing the key. Set on failures that occur AFTER the model
   * call has run (and its cost booked), so a retry cannot re-charge for work
   * that already happened. Defaults to retryable (release) when unset.
   */
  retryable?: boolean;
  policy?: import("../../policyErrors").PolicyErrorContext;
  /** Audit log id (`req_<n>`) when a request_logs row was written. */
  auditRequestId?: string;
}

export type ChatResult = ChatSuccess | ChatFailure;
