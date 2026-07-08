import type { SafetyPlan } from "@modelgov/policy-engine";
import type { ChatMessage } from "../../types";

// Leaf module: the safety contracts (interfaces + the fail-closed error) live
// here, NOT in the barrel, so implementations (composite/presidio/injection)
// never import back from index.ts — that value-import cycle was TDZ-fragile.

export interface SafetyFinding {
  type: "pii" | "prompt_injection";
  detail?: string;
}

export interface SafetyResult {
  action: "allow" | "block";
  /** Messages after masking (unchanged when nothing was masked). */
  messages: ChatMessage[];
  piiMasked: boolean;
  injectionBlocked: boolean;
  findings: SafetyFinding[];
  blockReason?: "pii_detected" | "prompt_injection" | "unscanned_image";
  /**
   * Real provider cost incurred by the safety pass itself (the injection
   * classifier makes a billable model call). The caller books this against the
   * budget so classifier spend does not bypass cost accounting. 0 when no
   * billable check ran (heuristic hit, checks disabled, or no classifier).
   */
  safetyCostUsd: number;
}

/** Result of inspecting a model's OUTPUT (PII only — injection is input-side). */
export interface OutputSafetyResult {
  action: "allow" | "block";
  /** Output after masking (unchanged when nothing was masked). */
  content: string;
  piiMasked: boolean;
  findings: SafetyFinding[];
  blockReason?: "output_pii_detected";
}

export interface SafetyGuard {
  inspectInput(messages: ChatMessage[], plan: SafetyPlan): Promise<SafetyResult>;
  /**
   * Inspect the model's completion before it is returned to the caller. With
   * `pii: mask` the output is masked; with `pii: block` PII in the output blocks
   * the response (the call already happened, so its cost is still settled).
   */
  inspectOutput(content: string, plan: SafetyPlan): Promise<OutputSafetyResult>;
}

/** Detects + masks PII in messages. */
export interface PiiGuard {
  process(
    messages: ChatMessage[],
  ): Promise<{ messages: ChatMessage[]; findings: SafetyFinding[] }>;
}

/** Result of an injection check: findings plus the billable classifier cost. */
export interface InjectionResult {
  findings: SafetyFinding[];
  /** Real provider cost of the classifier call (0 for the heuristic fast-path). */
  costUsd: number;
}

/** Detects prompt-injection attempts. */
export interface InjectionDetector {
  detect(messages: ChatMessage[]): Promise<InjectionResult>;
}

/**
 * A safety backend was enabled but failed (e.g. Presidio down, classifier
 * errored). v1 fails CLOSED: the API maps this to 503 rather than letting a
 * potentially-unsafe request through.
 */
export class SafetyServiceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafetyServiceError";
  }
}
