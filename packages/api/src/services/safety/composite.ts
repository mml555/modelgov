import type { SafetyPlan } from "@modelgov/policy-engine";
import { messageText, type ChatMessage } from "../../types";
import type {
  InjectionDetector,
  OutputSafetyResult,
  PiiGuard,
  SafetyFinding,
  SafetyGuard,
  SafetyResult,
} from "./contracts";
import { SafetyServiceError as SafetyBackendError } from "./contracts";

/**
 * Runs PII handling then injection detection, gated by the resolved safetyPlan.
 * Order matters: PII masking happens first so the injection classifier never
 * sees raw PII. Requested checks fail closed when their backend is missing.
 */
export class CompositeGuard implements SafetyGuard {
  constructor(
    private readonly pii: PiiGuard | null,
    private readonly injection: InjectionDetector | null,
  ) {}

  async inspectInput(
    messages: ChatMessage[],
    plan: SafetyPlan,
  ): Promise<SafetyResult> {
    let working = messages;
    let piiMasked = false;
    let safetyCostUsd = 0;
    const findings: SafetyFinding[] = [];

    // PII requested but no backend configured: we cannot honor the contract on
    // EITHER side, so fail closed here regardless of scope. Previously a
    // piiScope=output request skipped the input guard and leaked raw PII to the
    // provider AND the injection guard model before the output-side check threw.
    if (plan.pii !== "off" && !this.pii) {
      throw new SafetyBackendError("PII protection is enabled but Presidio is not configured");
    }

    // Image content parts are NOT scanned — Presidio and the injection classifier
    // only see text (messageText drops image parts). A "block" contract that
    // applies to the INPUT therefore cannot be honored for a message carrying an
    // image, so fail closed (block) rather than forward an unscanned image (a
    // photo of an ID card, or an instruction rendered as pixels) to the provider.
    // Scope matters: injection block is always input-side; PII block only applies
    // to the input when piiScope includes input (an output-only PII plan never
    // scanned the input anyway and still scans the completion via inspectOutput,
    // so an image is irrelevant to it). mask/off modes make no hard-block promise.
    const piiBlocksInput = plan.pii === "block" && plan.piiScope !== "output";
    const injectionBlocksInput = plan.promptInjection === "block";
    if (
      (piiBlocksInput || injectionBlocksInput) &&
      messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
      )
    ) {
      return {
        action: "block",
        messages,
        piiMasked: false,
        injectionBlocked: false,
        findings,
        blockReason: "unscanned_image",
        safetyCostUsd,
      };
    }

    // ── PII ── (input side: only when scope includes input)
    const pii = this.pii;
    const piiOnInput = plan.pii !== "off" && plan.piiScope !== "output";
    if (piiOnInput) {
      if (!pii) {
        throw new SafetyBackendError("PII protection is enabled but Presidio is not configured");
      }
      const result = await pii.process(working);
      if (result.findings.length > 0) {
        findings.push(...result.findings);
        if (plan.pii === "block") {
          return {
            action: "block",
            messages: working,
            piiMasked: false,
            injectionBlocked: false,
            findings,
            blockReason: "pii_detected",
            safetyCostUsd,
          };
        }
        // mask
        working = result.messages;
        piiMasked = true;
      }
    }

    // ── Prompt injection ──
    const injection = this.injection;
    if (plan.promptInjection === "block") {
      if (!injection) {
        throw new SafetyBackendError(
          "prompt-injection protection is enabled but no classifier is configured",
        );
      }
      // The classifier forwards text to a guard model, so it must never see raw
      // PII. When PII masking is enabled but scoped to output only (so `working`
      // is still un-masked), mask a COPY just for the classifier.
      let classifierInput = working;
      if (!piiOnInput && plan.pii !== "off" && pii) {
        classifierInput = (await pii.process(working)).messages;
      }
      const inj = await injection.detect(classifierInput);
      safetyCostUsd += inj.costUsd;
      if (inj.findings.length > 0) {
        findings.push(...inj.findings);
        return {
          action: "block",
          messages: working,
          piiMasked,
          injectionBlocked: true,
          findings,
          blockReason: "prompt_injection",
          safetyCostUsd,
        };
      }
    }

    return {
      action: "allow",
      messages: working,
      piiMasked,
      injectionBlocked: false,
      findings,
      safetyCostUsd,
    };
  }

  // Output is scanned for PII only (injection is an input-side concern). Fails
  // closed if PII protection is requested but no backend is configured.
  async inspectOutput(
    content: string,
    plan: SafetyPlan,
  ): Promise<OutputSafetyResult> {
    // Output side: only when PII is on AND scope includes output.
    if (plan.pii === "off" || plan.piiScope === "input") {
      return { action: "allow", content, piiMasked: false, findings: [] };
    }
    if (!this.pii) {
      throw new SafetyBackendError(
        "PII protection is enabled but Presidio is not configured",
      );
    }
    const result = await this.pii.process([{ role: "assistant", content }]);
    if (result.findings.length === 0) {
      return { action: "allow", content, piiMasked: false, findings: [] };
    }
    if (plan.pii === "block") {
      return {
        action: "block",
        content,
        piiMasked: false,
        findings: result.findings,
        blockReason: "output_pii_detected",
      };
    }
    // mask — output was submitted as a single string-content message, so the
    // masked result is likewise a string (messageText is a type-safe unwrap).
    return {
      action: "allow",
      content: result.messages[0] ? messageText(result.messages[0].content) : content,
      piiMasked: true,
      findings: result.findings,
    };
  }
}
