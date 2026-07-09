/** Common provider-key prefixes, for a non-blocking "that doesn't look right" hint. */
const KEY_PREFIXES: Record<string, { prefix: string; example: string }> = {
  OPENAI_API_KEY: { prefix: "sk-", example: "sk-…" },
  ANTHROPIC_API_KEY: { prefix: "sk-ant-", example: "sk-ant-…" },
  OPENROUTER_API_KEY: { prefix: "sk-or-", example: "sk-or-…" },
  GEMINI_API_KEY: { prefix: "AIza", example: "AIza…" },
  GROQ_API_KEY: { prefix: "gsk_", example: "gsk_…" },
  XAI_API_KEY: { prefix: "xai-", example: "xai-…" },
  AWS_ACCESS_KEY_ID: { prefix: "AKIA", example: "AKIA… (or ASIA… for temporary)" },
};

/**
 * Returns a gentle, non-blocking warning when a pasted key clearly doesn't match
 * the provider's usual prefix — catches a wrong-field paste before Apply.
 * Returns null when empty, unknown, or plausibly correct (never blocks progress).
 */
export function keyFormatWarning(key: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const spec = KEY_PREFIXES[key];
  if (!spec) return null;
  // AWS temporary (STS) keys start with ASIA; accept either.
  if (key === "AWS_ACCESS_KEY_ID" && v.startsWith("ASIA")) return null;
  if (v.startsWith(spec.prefix)) return null;
  return `This doesn't look like a ${key
    .replace(/_/g, " ")
    .toLowerCase()} (usually starts with ${spec.example}). Double-check you pasted the right value.`;
}
