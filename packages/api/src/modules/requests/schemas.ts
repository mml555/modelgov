import { z } from "zod";

export const requestListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  userType: z.string().min(1).optional(),
  status: z.enum(["completed", "blocked", "safety_blocked", "error"]).optional(),
  reasonCode: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  projectId: z.string().min(1).optional(),
});

export const requestRecordJsonSchema = {
  type: "object",
  required: ["id", "status", "decision", "feature", "safety", "timestamps"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["completed", "blocked", "safety_blocked", "error"] },
    decision: { type: "string" },
    reasonCode: { type: "string" },
    reason: { type: "string" },
    feature: { type: "string" },
    userType: { type: "string" },
    userId: { type: "string" },
    projectId: { type: "string" },
    environment: { type: "string" },
    requestedModelClass: { type: "string" },
    resolvedModelClass: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    estimatedCostUsd: { type: "number" },
    actualCostUsd: { type: "number" },
    inputTokens: { type: "integer" },
    outputTokens: { type: "integer" },
    safety: {
      type: "object",
      required: ["pii", "promptInjection"],
      properties: {
        pii: { type: "string", enum: ["masked", "blocked", "none"] },
        promptInjection: { type: "string", enum: ["blocked", "passed"] },
      },
    },
    timestamps: {
      type: "object",
      required: ["createdAt"],
      properties: {
        createdAt: { type: "string" },
      },
    },
    policy: {
      type: "object",
      properties: {
        configHash: { type: "string" },
        policyVersion: { type: "string" },
      },
    },
  },
} as const;

export const requestListJsonSchema = {
  type: "object",
  required: ["items", "limit"],
  properties: {
    items: { type: "array", items: requestRecordJsonSchema },
    limit: { type: "integer" },
  },
} as const;
