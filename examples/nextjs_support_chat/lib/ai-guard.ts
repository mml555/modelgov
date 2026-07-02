import { createAiGuardClient } from "@ai-guard/sdk";

export const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL ?? "http://localhost:3000",
  apiKey: process.env.AI_GUARD_API_KEY,
});
