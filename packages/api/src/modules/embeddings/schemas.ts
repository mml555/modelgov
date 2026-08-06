import { z } from "zod";
import { budgetRemainingJsonSchema, costJsonSchema } from "../chat/schemas";

// Bounds on caller-supplied size. Embeddings batch many chunks per call (an
// ingestion pass over a doc corpus), so the item cap is higher than chat's
// message cap; the per-item char cap plus the 1 MiB body wall bound total size.
const MAX_INPUTS = 256;
const MAX_INPUT_CHARS = 32_000;
const MAX_METADATA_KEYS = 32;

export const embeddingsBodySchema = z.object({
  userId: z.string().min(1),
  userType: z.string().min(1),
  feature: z.string().min(1),
  // Accept a single string or an array; the service normalizes to string[].
  input: z.union([
    z.string().min(1).max(MAX_INPUT_CHARS),
    z.array(z.string().min(1).max(MAX_INPUT_CHARS)).min(1).max(MAX_INPUTS),
  ]),
  modelClass: z.string().optional(),
  /**
   * Output vector width for Matryoshka models. Upper bound is generous on
   * purpose — the real ceiling is the model's native width, which only the
   * provider knows, so an over-large value should surface as a provider error
   * rather than a gateway guess that goes stale as models change.
   */
  dimensions: z.number().int().positive().max(16_384).optional(),
  inputTokensEstimate: z.number().int().positive().optional(),
  projectId: z.string().optional(),
  environment: z.string().optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, {
      message: `metadata may not exceed ${MAX_METADATA_KEYS} keys`,
    })
    .optional(),
});

export type EmbeddingsInput = z.infer<typeof embeddingsBodySchema>;

export const embeddingsBodyJsonSchema = {
  type: "object",
  required: ["userId", "userType", "feature", "input"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1 },
    userType: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
    input: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS },
        {
          type: "array",
          minItems: 1,
          maxItems: MAX_INPUTS,
          items: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS },
        },
      ],
    },
    modelClass: { type: "string" },
    dimensions: {
      type: "integer",
      minimum: 1,
      maximum: 16384,
      description:
        "Output vector width (Matryoshka models: text-embedding-3-*, gemini-embedding-001). Omit for the model's native width. The response echoes it so you can assert vector-space identity.",
    },
    inputTokensEstimate: { type: "integer", minimum: 1 },
    projectId: { type: "string" },
    environment: { type: "string" },
    metadata: { type: "object", additionalProperties: true, maxProperties: MAX_METADATA_KEYS },
  },
} as const;

export const embeddingsSuccessJsonSchema = {
  type: "object",
  required: ["embeddings", "model", "provider", "decision", "usage", "cost", "budgetRemaining", "requestId"],
  properties: {
    embeddings: {
      type: "array",
      items: { type: "array", items: { type: "number" } },
    },
    model: { type: "string" },
    // Not in `required`: completed idempotency rows replay VERBATIM for a week,
    // so a replay can return a body cached before this field existed. Absent
    // means "unknown, from an older response", not "zero-width".
    dimensions: {
      type: ["integer", "null"],
      description: "Width of the returned vectors, read off the response — assert this rather than assuming the model's default.",
    },
    provider: { type: "string" },
    decision: { type: "string", enum: ["allow", "degrade", "fallback"] },
    reason: { type: "string" },
    usage: {
      type: "object",
      required: ["inputTokens"],
      properties: {
        inputTokens: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    },
    cost: costJsonSchema,
    budgetRemaining: budgetRemainingJsonSchema,
    requestId: { type: "string" },
  },
} as const;
