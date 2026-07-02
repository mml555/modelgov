import { createAiGuardClient } from "@ai-guard/sdk";

// One shared client. Point AI_GUARD_URL at your Ai-Guard gateway.
export const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL ?? "http://localhost:3000",
  apiKey: process.env.AI_GUARD_API_KEY,
});
