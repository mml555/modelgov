import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiGuardError } from "@ai-guard/sdk";
import { ai, EMBED_FEATURE, INGESTOR, RAG_DATABASE_URL } from "./aiguard.js";
import { chunkMarkdown } from "./chunk.js";
import { count, createPool, initStore, insertRecords, type KbRecord } from "./store.js";

const KB_DIR = fileURLToPath(new URL("../kb", import.meta.url));

/**
 * Build the pgvector store: read the KB, chunk it, embed every chunk through the
 * gateway's governed /v1/embeddings (feature `kb_embedding`, user `ingestor`),
 * and write the vectors to Postgres. The embedding call is budgeted + audited
 * like any other AI spend.
 */
async function main(): Promise<void> {
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith(".md")).sort();
  const chunks = [];
  for (const f of files) {
    const md = await readFile(path.join(KB_DIR, f), "utf8");
    chunks.push(...chunkMarkdown(f, md));
  }
  console.log(`Chunked ${files.length} docs → ${chunks.length} passages.`);
  if (chunks.length === 0) throw new Error(`no .md files found in ${KB_DIR}`);

  let res;
  try {
    res = await ai.embed({
      userId: "ingest-job",
      userType: INGESTOR,
      feature: EMBED_FEATURE,
      input: chunks.map((c) => c.text),
    });
  } catch (err) {
    if (err instanceof AiGuardError) {
      console.error(`\n⛔ embedding blocked by Ai-Guard (${err.code}): ${JSON.stringify(err.body)}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `Embedded ${res.embeddings.length} chunks via ${res.model} (${res.provider}) · ` +
      `$${res.cost.actualUsd} · req ${res.requestId}`,
  );

  // Fail loud on a partial/misaligned response rather than inserting empty
  // vectors — otherwise `res.embeddings[i] ?? []` would write zero-length rows
  // and the multi-row INSERT dies with an opaque pgvector dimension mismatch.
  if (res.embeddings.length !== chunks.length) {
    throw new Error(
      `embeddings count mismatch: got ${res.embeddings.length} vectors for ${chunks.length} chunks`,
    );
  }
  if (res.embeddings.some((v) => !v || v.length === 0)) {
    throw new Error("embeddings response contained an empty vector");
  }

  const records: KbRecord[] = chunks.map((c, i) => ({
    source: c.source,
    text: c.text,
    embedding: res.embeddings[i] as number[],
  }));
  const dimensions = records[0]?.embedding.length ?? 0;
  if (dimensions === 0) throw new Error("embeddings came back empty");

  const pool = createPool(RAG_DATABASE_URL);
  try {
    await initStore(pool, dimensions);
    await insertRecords(pool, records);
    console.log(`Wrote ${await count(pool)} vectors (dim ${dimensions}) → pgvector (kb_chunks).`);
  } finally {
    await pool.end();
  }
}

void main();
