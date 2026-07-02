import type { SafetyPlan } from "@ai-guard/policy-engine";
import type { ChatMessage } from "../../types";
import type { OutputSafetyResult, SafetyGuard, SafetyResult } from "./index";

/** Pass-through guard for dev / `preset: dev` / tests. */
export class NoopGuard implements SafetyGuard {
  async inspectInput(
    messages: ChatMessage[],
    _plan: SafetyPlan,
  ): Promise<SafetyResult> {
    return {
      action: "allow",
      messages,
      piiMasked: false,
      injectionBlocked: false,
      findings: [],
      safetyCostUsd: 0,
    };
  }

  async inspectOutput(
    content: string,
    _plan: SafetyPlan,
  ): Promise<OutputSafetyResult> {
    return { action: "allow", content, piiMasked: false, findings: [] };
  }
}
