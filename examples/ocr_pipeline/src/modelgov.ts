import { createModelgovClient } from "@modelgov/sdk";

// One shared client pointed at the Modelgov gateway (which must load this
// folder's modelgov.yaml). Every vision extraction call goes through it.
export const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
  // Vision payloads (page images) are large and slow on local models.
  timeoutMs: 180_000,
  apiKey: process.env.MODELGOV_API_KEY,
});

// Feature / user-type names live in THIS example's modelgov.yaml.
export const EXTRACT_FEATURE = "document_extraction" as never;
export const WORKFLOW = "workflow" as never;
