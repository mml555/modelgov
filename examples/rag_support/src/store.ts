import pg from "pg";

// pgvector-backed KB store. Embeddings live in Postgres; retrieval is a cosine
// nearest-neighbour query (`embedding <=> $query`) with an HNSW index. This is
// the production-grade replacement for the earlier in-memory JSON store.

export type Pool = pg.Pool;

export interface KbChunk {
  id: string;
  /** e.g. "billing.md#Refunds" — shown to the user as the source. */
  source: string;
  text: string;
}

export interface KbRecord {
  source: string;
  text: string;
  embedding: number[];
}

export interface ScoredChunk extends KbChunk {
  score: number;
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString });
}

/** pgvector accepts the literal text form `[1,2,3]` for a vector value. */
export function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Create the pgvector extension + `kb_chunks` table sized to the embedding
 * dimension, with an HNSW cosine index. Recreated each ingest so re-running is
 * idempotent (a demo KB is small; for incremental updates you'd upsert instead).
 */
export async function initStore(pool: Pool, dimensions: number): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query("DROP TABLE IF EXISTS kb_chunks");
  await pool.query(
    `CREATE TABLE kb_chunks (
       id serial PRIMARY KEY,
       source text NOT NULL,
       chunk text NOT NULL,
       embedding vector(${dimensions}) NOT NULL
     )`,
  );
  await pool.query("CREATE INDEX ON kb_chunks USING hnsw (embedding vector_cosine_ops)");
}

export async function insertRecords(pool: Pool, records: KbRecord[]): Promise<void> {
  if (records.length === 0) return;
  // Single multi-row INSERT (one round-trip) rather than one query per record.
  const values: string[] = [];
  const params: unknown[] = [];
  records.forEach((r, i) => {
    const b = i * 3;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
    params.push(r.source, r.text, toVector(r.embedding));
  });
  await pool.query(
    `INSERT INTO kb_chunks (source, chunk, embedding) VALUES ${values.join(", ")}`,
    params,
  );
}

export async function count(pool: Pool): Promise<number> {
  const res = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM kb_chunks");
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * The k most similar chunks to the query vector. `<=>` is pgvector's cosine
 * distance (0 = identical); we return `score = 1 - distance` so higher is more
 * similar, matching the old JSON store's contract.
 */
export async function topK(pool: Pool, queryEmbedding: number[], k: number): Promise<ScoredChunk[]> {
  const vec = toVector(queryEmbedding);
  const res = await pool.query<{ id: number; source: string; chunk: string; distance: string }>(
    `SELECT id, source, chunk, embedding <=> $1 AS distance
       FROM kb_chunks
      ORDER BY embedding <=> $1
      LIMIT $2`,
    [vec, k],
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    source: row.source,
    text: row.chunk,
    score: 1 - Number(row.distance),
  }));
}
