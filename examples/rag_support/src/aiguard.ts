import { createAiGuardClient } from "@ai-guard/sdk";

// One shared client pointed at the Ai-Guard gateway (which must load this
// folder's ai-guard.yaml). Every embed + chat call goes through it.
export const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL ?? "http://localhost:3000",
  apiKey: process.env.AI_GUARD_API_KEY,
});

// Postgres/pgvector connection for the KB store (defaults to the local stack).
export const RAG_DATABASE_URL =
  process.env.RAG_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aiguard";

// Feature / user-type names live in THIS example's ai-guard.yaml, not the root
// config the SDK generated its unions from — so callers pass them via these
// helpers, casting once here instead of at every call site.
export const EMBED_FEATURE = "kb_embedding" as never;
export const CHAT_FEATURE = "support_chat" as never;
export const INGESTOR = "ingestor" as never;
export const VISITOR = "visitor" as never;
