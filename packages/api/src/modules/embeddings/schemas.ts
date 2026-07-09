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
