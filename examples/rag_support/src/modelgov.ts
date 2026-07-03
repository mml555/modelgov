import { createModelgovClient } from "@modelgov/sdk";

// One shared client pointed at the Modelgov gateway (which must load this
// folder's modelgov.yaml). Every embed + chat call goes through it.
export const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
  apiKey: process.env.MODELGOV_API_KEY,
});

// Postgres/pgvector connection for the KB store (defaults to the local stack).
export const RAG_DATABASE_URL =
  process.env.RAG_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/modelgov";

// Feature / user-type names live in THIS example's modelgov.yaml, not the root
// config the SDK generated its unions from — so callers pass them via these
// helpers, casting once here instead of at every call site.
export const EMBED_FEATURE = "kb_embedding" as never;
export const CHAT_FEATURE = "support_chat" as never;
export const INGESTOR = "ingestor" as never;
export const VISITOR = "visitor" as never;
