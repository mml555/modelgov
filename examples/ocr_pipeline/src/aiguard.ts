import { createAiGuardClient } from "@ai-guard/sdk";

// One shared client pointed at the Ai-Guard gateway (which must load this
// folder's ai-guard.yaml). Every vision extraction call goes through it.
export const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL ?? "http://localhost:3000",
  // Vision payloads (page images) are large and slow on local models.
  timeoutMs: 180_000,
  apiKey: process.env.AI_GUARD_API_KEY,
});

// Feature / user-type names live in THIS example's ai-guard.yaml.
export const EXTRACT_FEATURE = "document_extraction" as never;
export const WORKFLOW = "workflow" as never;
