import type { PiiDisposition, PiiEntityPolicy } from "@modelgov/policy-engine";
import type { ChatMessage } from "../../types";
import { SafetyServiceError, type PiiGuard, type SafetyFinding } from "./contracts";

interface PresidioEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface PresidioOptions {
  analyzerUrl: string;
  anonymizerUrl: string;
  language?: string;
  /** Per-call timeout; a hung Presidio must not stall the whole request. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * PII detection + masking via Microsoft Presidio (analyzer + anonymizer
 * services). Masking replaces every detected entity with "[REDACTED]".
 */
export class PresidioPiiGuard implements PiiGuard {
  private readonly analyzerUrl: string;
  private readonly anonymizerUrl: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PresidioOptions) {
    this.analyzerUrl = opts.analyzerUrl.replace(/\/$/, "");
    this.anonymizerUrl = opts.anonymizerUrl.replace(/\/$/, "");
    this.language = opts.language ?? "en";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async process(
    messages: ChatMessage[],
    policy?: PiiEntityPolicy,
  ): Promise<{ messages: ChatMessage[]; findings: SafetyFinding[] }> {
    // Screen messages concurrently: a long conversation would otherwise incur
    // 2N sequential Presidio round-trips on the request hot path. Promise.all
    // preserves order, so masked messages stay aligned with their originals.
    const processed = await Promise.all(
      messages.map(async (message) => {
        // Multimodal message: mask each text part independently (so anonymizer
        // offsets stay valid) and pass image parts through untouched — Presidio
        // is text-only and would choke on a data URI.
        if (Array.isArray(message.content)) {
          const partResults = await Promise.all(
            message.content.map(async (part) => {
              if (part.type !== "text" || !part.text) {
                return { part, findings: [] as SafetyFinding[] };
              }
              return this.maskText(part.text, policy).then((r) => ({
                part: { ...part, text: r.content },
                findings: r.findings,
              }));
            }),
          );
          return {
            message: { ...message, content: partResults.map((r) => r.part) },
            findings: partResults.flatMap((r) => r.findings),
          };
        }

        if (!message.content) return { message, findings: [] as SafetyFinding[] };
        const { content, findings } = await this.maskText(message.content, policy);
        return { message: { ...message, content }, findings };
      }),
    );

    return {
      messages: processed.map((p) => p.message),
      findings: processed.flatMap((p) => p.findings),
    };
  }

  /** Analyze + anonymize a single text string. Returns the (possibly masked)
   * text and any PII findings. No round-trip when the text is clean. */
  private async maskText(
    text: string,
    policy?: PiiEntityPolicy,
  ): Promise<{ content: string; findings: SafetyFinding[] }> {
    // Always analyze for EVERY entity type, even under a deny-list policy that
    // will pass most of them through: the findings are the audit record, and
    // restricting the analyzer would make "no PERSON was present" and "we never
    // looked for PERSON" indistinguishable afterwards.
    const entities = await this.analyze(text);
    if (entities.length === 0) return { content: text, findings: [] };

    const findings: SafetyFinding[] = entities.map((e) => ({
      type: "pii",
      detail: e.entity_type,
      ...(policy ? { disposition: dispositionFor(e.entity_type, policy) } : {}),
    }));

    // Only `mask` entities go to the anonymizer. `allow` stays in the text by
    // definition; `block` is left intact too — the caller rejects the request,
    // and redacting the evidence first would only make the rejection harder to
    // explain.
    const toMask = policy
      ? entities.filter((e) => dispositionFor(e.entity_type, policy) === "mask")
      : entities;
    if (toMask.length === 0) return { content: text, findings };

    const anonymized = await this.anonymize(text, toMask);
    return { content: anonymized, findings };
  }

  private async analyze(text: string): Promise<PresidioEntity[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.analyzerUrl}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language: this.language }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SafetyServiceError("Presidio analyzer unreachable", { cause: err });
    }
    if (!res.ok) {
      throw new SafetyServiceError(`Presidio analyzer returned ${res.status}`);
    }
    const body = await res.json().catch(() => null);
    // Fail closed on an off-shape response: a non-array body must not fall
    // through to `.length`/`.map` (which would throw a raw 500 rather than the
    // intended fail-closed 503) or be silently treated as "no PII".
    if (!Array.isArray(body)) {
      throw new SafetyServiceError(
        "Presidio analyzer returned an unexpected (non-array) response",
      );
    }
    return body as PresidioEntity[];
  }

  private async anonymize(
    text: string,
    entities: PresidioEntity[],
  ): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.anonymizerUrl}/anonymize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          analyzer_results: entities.map((e) => ({
            entity_type: e.entity_type,
            start: e.start,
            end: e.end,
            score: e.score,
          })),
          anonymizers: {
            DEFAULT: { type: "replace", new_value: "[REDACTED]" },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SafetyServiceError("Presidio anonymizer unreachable", { cause: err });
    }
    if (!res.ok) {
      throw new SafetyServiceError(`Presidio anonymizer returned ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as { text?: unknown } | null;
    // Fail closed: if the anonymizer response lacks masked text, we must NOT
    // fall back to the original (which still contains the PII we were asked to
    // redact) — that would leak PII while reporting it as masked.
    if (!json || typeof json.text !== "string") {
      throw new SafetyServiceError(
        "Presidio anonymizer returned no masked text",
      );
    }
    return json.text;
  }
}

/**
 * Disposition for one detected entity type. Explicit lists win over `default`;
 * an entity cannot appear in two lists (config validation rejects that), so the
 * order these are checked in is not load-bearing.
 */
function dispositionFor(entityType: string, policy: PiiEntityPolicy): PiiDisposition {
  if (policy.block?.includes(entityType)) return "block";
  if (policy.mask?.includes(entityType)) return "mask";
  if (policy.allow?.includes(entityType)) return "allow";
  return policy.default;
}
