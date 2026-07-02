import { ai, EMBED_FEATURE, VISITOR } from "./aiguard.js";
import { topK, type Pool, type ScoredChunk } from "./store.js";

export interface RetrievalReceipt {
  model: string;
  costUsd: number;
  requestId: string;
}

export interface Retrieval {
  chunks: ScoredChunk[];
  receipt: RetrievalReceipt;
}

/**
 * Embed the visitor's question (governed, billed to that visitor) and return
 * the k most similar KB chunks via pgvector. The embedding spend is attributed
 * to the same userId as the chat, so per-visitor budgets cover retrieval too.
 */
export async function retrieve(
  pool: Pool,
  query: string,
  userId: string,
  k = 4,
): Promise<Retrieval> {
  const res = await ai.embed({
    userId,
    userType: VISITOR,
    feature: EMBED_FEATURE,
    input: query,
  });
  const queryVec = res.embeddings[0];
  if (!queryVec || queryVec.length === 0) {
    throw new Error("query embedding came back empty from the gateway");
  }
  return {
    chunks: await topK(pool, queryVec, k),
    receipt: { model: res.model, costUsd: res.cost.actualUsd, requestId: res.requestId },
  };
}
