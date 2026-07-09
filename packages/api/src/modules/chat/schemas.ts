import { z } from "zod";

// Bounds on caller-supplied size. The 1 MiB body limit is the outer wall; these
// stop a request from packing thousands of messages the injection classifier
// then concatenates and forwards, amplifying cost, latency, and the 503 surface.
const MAX_MESSAGES = 64;
const MAX_CONTENT_CHARS = 100_000;
const MAX_METADATA_KEYS = 32;
// Multimodal (vision) bounds: how many parts per message, and how long an
// image `url` may be. A `data:` URI holds a whole base64 image, so the url cap
// is generous — but a vision deployment still needs a raised body limit
// (bodyLimitBytes) to accept full-page scans.
const MAX_CONTENT_PARTS = 32;
const MAX_IMAGE_URL_CHARS = 12_000_000;

// Only inline data: URIs and public https: image URLs are accepted. The upstream
// provider / vision backend dereferences image_url, so an arbitrary http(s) URL
// pointing at an internal address (e.g. http://169.254.169.254/… or
// http://localhost) is an SSRF vector executed from inside the operator's
// network. data: is inlined (no fetch); https is the only network scheme allowed.
function isAllowedImageUrl(url: string): boolean {
  if (url.startsWith("data:")) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(MAX_CONTENT_CHARS),
});
const imagePartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z
      .string()
      .min(1)
      .max(MAX_IMAGE_URL_CHARS)
      .refine(isAllowedImageUrl, {
        message: "image_url.url must be a data: URI or an https: URL (SSRF guard)",
      }),
    detail: z.enum(["low", "high", "auto"]).optional(),
  }),
});
const contentPartSchema = z.discriminatedUnion("type", [textPartSchema, imagePartSchema]);

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  // A plain string, or OpenAI-style content parts (text + images) for vision.
  content: z.union([
    z.string().max(MAX_CONTENT_CHARS),
    z.array(contentPartSchema).min(1).max(MAX_CONTENT_PARTS),
  ]),
});

export const chatBodySchema = z.object({
  userId: z.string().min(1),
  userType: z.string().min(1),
  feature: z.string().min(1),
  modelClass: z.string().optional(),
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  /**
   * Retrieved context passages for a grounded feature. When the feature's
   * safety plan sets grounding=strict, the gateway answers ONLY from these,
   * requires the model to cite verbatim quotes, and verifies them.
   */
  context: z.array(z.string().min(1).max(MAX_CONTENT_CHARS)).min(1).max(64).optional(),
  // Bounded above: an unbounded estimate can overflow the numeric(14,6) reserve
  // column and 500 the request (and, in billing mode, after the credit hold).
  inputTokensEstimate: z.number().int().positive().max(10_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Stream the completion as SSE. Requires the feature's output PII mode to be off. */
  stream: z.boolean().optional(),
  /** Leaf budget node to bill against (hierarchical budgets; requires the flag). */
  budgetNodeId: z.string().min(1).optional(),
  projectId: z.string().optional(),
  environment: z.string().optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, {
      message: `metadata may not exceed ${MAX_METADATA_KEYS} keys`,
    })
    .optional(),
});

export const chatBodyJsonSchema = {
  type: "object",
  required: ["userId", "userType", "feature", "messages"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1 },
    userType: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
    modelClass: { type: "string" },
    messages: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        required: ["role", "content"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: {
            anyOf: [
              { type: "string", maxLength: 100000 },
              {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: {
                  anyOf: [
                    {
                      type: "object",
                      required: ["type", "text"],
                      additionalProperties: false,
                      properties: {
                        type: { const: "text" },
                        text: { type: "string", maxLength: 100000 },
                      },
                    },
                    {
                      type: "object",
                      required: ["type", "image_url"],
                      additionalProperties: false,
                      properties: {
                        type: { const: "image_url" },
                        image_url: {
                          type: "object",
                          required: ["url"],
                          additionalProperties: false,
                          properties: {
                            url: { type: "string", minLength: 1, maxLength: 12000000 },
                            detail: { type: "string", enum: ["low", "high", "auto"] },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    context: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 100000 },
    },
    inputTokensEstimate: { type: "integer", minimum: 1 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    stream: { type: "boolean" },
    budgetNodeId: { type: "string" },
    projectId: { type: "string" },
    environment: { type: "string" },
    metadata: { type: "object", additionalProperties: true, maxProperties: 32 },
  },
} as const;

// Shared response fragments — chat, embeddings, and documents all return the
// same `cost` and `budgetRemaining` shapes (BudgetRemaining is one engine type),
// so they reference these instead of re-declaring the block (which drifts).
export const costJsonSchema = {
  type: "object",
  required: ["estimatedUsd", "actualUsd"],
  properties: {
    estimatedUsd: { type: "number" },
    actualUsd: { type: "number" },
  },
} as const;

export const budgetRemainingJsonSchema = {
  // null under hierarchical budgets (the node tree is the authority).
  anyOf: [
    {
      type: "object",
      required: ["userDailyUsd", "featureMonthlyUsd", "globalMonthlyUsd"],
      properties: {
        userDailyUsd: { type: "number" },
        featureMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
        globalMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
        userDailyTokens: { anyOf: [{ type: "number" }, { type: "null" }] },
        featureMonthlyTokens: { anyOf: [{ type: "number" }, { type: "null" }] },
        globalMonthlyTokens: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
    },
    { type: "null" },
  ],
} as const;

export const chatSuccessJsonSchema = {
  type: "object",
  required: ["message", "model", "provider", "decision", "usage", "cost", "budgetRemaining", "safety", "requestId"],
  properties: {
    message: {
      type: "object",
      required: ["role", "content"],
      properties: {
        role: { type: "string" },
        content: { type: "string" },
      },
    },
    model: { type: "string" },
    provider: { type: "string" },
    decision: { type: "string", enum: ["allow", "degrade", "fallback"] },
    reason: { type: "string" },
    usage: {
      type: "object",
      required: ["inputTokens", "outputTokens"],
      properties: {
        inputTokens: { anyOf: [{ type: "integer" }, { type: "null" }] },
        outputTokens: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    },
    cost: costJsonSchema,
    budgetRemaining: budgetRemainingJsonSchema,
    safety: {
      type: "object",
      required: ["piiMasked", "injectionBlocked"],
      properties: {
        piiMasked: { type: "boolean" },
        injectionBlocked: { type: "boolean" },
        // Present only for grounded features: did the answer's citations verify?
        grounded: { type: "boolean" },
      },
    },
    requestId: { type: "string" },
  },
} as const;

export const errorJsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "details", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: { type: "object", additionalProperties: true },
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
} as const;
