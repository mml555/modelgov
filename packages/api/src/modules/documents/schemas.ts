import { z } from "zod";
import { budgetRemainingJsonSchema, costJsonSchema } from "../chat/schemas";

// A base64 scan is large; the request body limit (REQUEST_BODY_LIMIT_BYTES) is
// the outer wall — a vision/document deployment must raise it to accept inline
// documents, exactly like the chat vision path. This char cap is a coarse upper
// bound so a single field can't be unbounded within an already-raised limit.
const MAX_BASE64_CHARS = 40_000_000;
const MAX_URL_CHARS = 4_000;
const MAX_S3_CHARS = 2_048;
const MAX_METADATA_KEYS = 32;
const MAX_PAGES_ESTIMATE = 10_000;

const documentSourceSchema = z
  .object({
    base64: z.string().min(1).max(MAX_BASE64_CHARS).optional(),
    url: z.string().min(1).max(MAX_URL_CHARS).optional(),
    s3: z.string().min(1).max(MAX_S3_CHARS).optional(),
  })
  .refine(
    (d) => [d.base64, d.url, d.s3].filter((v) => v !== undefined).length === 1,
    { message: "document must have exactly one of base64, url, or s3" },
  );

export const documentBodySchema = z.object({
  provider: z.string().min(1).max(64),
  userId: z.string().min(1),
  userType: z.string().min(1),
  feature: z.string().min(1),
  modelClass: z.string().optional(),
  document: documentSourceSchema,
  /** Caller estimate of page count, used for the pre-call budget reserve. */
  pages: z.number().int().positive().max(MAX_PAGES_ESTIMATE).optional(),
  projectId: z.string().optional(),
  environment: z.string().optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, {
      message: `metadata may not exceed ${MAX_METADATA_KEYS} keys`,
    })
    .optional(),
});

export type DocumentBody = z.infer<typeof documentBodySchema>;

export const documentBodyJsonSchema = {
  type: "object",
  required: ["provider", "userId", "userType", "feature", "document"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 64 },
    userId: { type: "string", minLength: 1 },
    userType: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
    modelClass: { type: "string" },
    document: {
      type: "object",
      additionalProperties: false,
      // Exactly one source; enforced precisely by the zod refine above.
      minProperties: 1,
      maxProperties: 1,
      properties: {
        base64: { type: "string", minLength: 1, maxLength: MAX_BASE64_CHARS },
        url: { type: "string", minLength: 1, maxLength: MAX_URL_CHARS },
        s3: { type: "string", minLength: 1, maxLength: MAX_S3_CHARS },
      },
    },
    pages: { type: "integer", minimum: 1, maximum: MAX_PAGES_ESTIMATE },
    projectId: { type: "string" },
    environment: { type: "string" },
    metadata: { type: "object", additionalProperties: true, maxProperties: MAX_METADATA_KEYS },
  },
} as const;

export const documentSuccessJsonSchema = {
  type: "object",
  required: ["text", "pages", "provider", "decision", "cost", "budgetRemaining", "safety", "requestId"],
  properties: {
    text: { type: "string" },
    pages: { type: "integer" },
    provider: { type: "string" },
    model: { type: "string" },
    decision: { type: "string", enum: ["allow", "degrade"] },
    reason: { type: "string" },
    cost: costJsonSchema,
    budgetRemaining: budgetRemainingJsonSchema,
    safety: {
      type: "object",
      required: ["piiMasked"],
      properties: { piiMasked: { type: "boolean" } },
    },
    requestId: { type: "string" },
  },
} as const;
