import { z } from "zod";

export const explainBodySchema = z.object({
  userId: z.string().min(1),
  userType: z.string().min(1),
  feature: z.string().min(1),
  modelClass: z.string().optional(),
  inputTokensEstimate: z.number().int().positive().optional(),
  projectId: z.string().optional(),
  environment: z.string().optional(),
});

export const explainBodyJsonSchema = {
  type: "object",
  required: ["userId", "userType", "feature"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1 },
    userType: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
    modelClass: { type: "string" },
    inputTokensEstimate: { type: "integer", minimum: 1 },
    projectId: { type: "string" },
    environment: { type: "string" },
  },
} as const;

export const explainSuccessJsonSchema = {
  type: "object",
  required: [
    "decision",
    "requested",
    "resolved",
    "safety",
    "cost",
    "budget",
    "wouldCallModel",
    "summary",
  ],
  properties: {
    decision: { type: "string", enum: ["allow", "block", "degrade", "fallback"] },
    reason: { type: "string" },
    reasonCode: { type: "string" },
    requested: {
      type: "object",
      required: ["userId", "userType", "feature", "modelClass"],
      properties: {
        userId: { type: "string" },
        userType: { type: "string" },
        feature: { type: "string" },
        modelClass: { type: "string" },
      },
    },
    resolved: {
      type: "object",
      required: ["modelClass", "model", "provider"],
      properties: {
        modelClass: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        fallbackModel: { type: "string" },
      },
    },
    safety: {
      type: "object",
      required: ["preset", "pii", "promptInjection", "maxOutputTokens"],
      properties: {
        preset: { type: "string" },
        pii: { type: "string" },
        promptInjection: { type: "string" },
        maxOutputTokens: { type: "integer" },
      },
    },
    cost: {
      type: "object",
      required: ["estimatedUsd"],
      properties: {
        estimatedUsd: { type: "number" },
      },
    },
    budget: {
      type: "object",
      required: [
        "remaining",
        "used",
        "permittedModels",
        "dailyRequestLimit",
        "dailyRequestsRemaining",
      ],
      properties: {
        remaining: {
          type: "object",
          required: ["userDailyUsd", "featureMonthlyUsd", "globalMonthlyUsd"],
          properties: {
            userDailyUsd: { type: "number" },
            featureMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
            globalMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
          },
        },
        used: {
          type: "object",
          required: [
            "userDailyUsd",
            "userDailyRequests",
            "featureMonthlyUsd",
            "globalMonthlyUsd",
          ],
          properties: {
            userDailyUsd: { type: "number" },
            userDailyRequests: { type: "integer" },
            featureMonthlyUsd: { type: "number" },
            globalMonthlyUsd: { type: "number" },
          },
        },
        permittedModels: { type: "array", items: { type: "string" } },
        dailyRequestLimit: { type: "integer" },
        dailyRequestsRemaining: { type: "integer" },
      },
    },
    wouldCallModel: { type: "boolean" },
    summary: { type: "string" },
  },
} as const;
