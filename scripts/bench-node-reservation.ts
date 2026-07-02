/**
 * Micro-benchmark for hierarchical-budget reservation contention: unsharded vs
 * sharded top node. Measures reservation throughput (ops/sec) and p95 latency
 * under concurrency against a real Postgres.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/bench-node-reservation.ts
 *
 * These are LOCAL numbers (single box, test DB) meant to show the *relative*
 * effect of sharding — not production RPS (see docs/deployment/benchmarks.md).
 */
import { createPool } from "../packages/api/src/db/pool";
import { applySchema } from "../packages/api/src/db/init";
import { createNode, reservePath } from "../packages/api/src/modules/budgets/repo";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const TOTAL = Number(process.env.BENCH_OPS ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const NOW = new Date("2026-07-01T12:00:00Z");

async function runScenario(pool: Awaited<ReturnType<typeof createPool>>, label: string, shardCount: number) {
  const org = await createNode(pool, { tenantId: "bench", kind: "org", name: label, capUsd: 1_000_000, shardCount });
  const nodes = [org];
  const latencies: number[] = [];
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < TOTAL) {
      const i = next++;
      const start = process.hrtime.bigint();
      await reservePath(pool, { nodes, estimatedCostUsd: 0.0001, now: NOW, shardKey: `u-${i}` });
      const end = process.hrtime.bigint();
      latencies.push(Number(end - start) / 1e6);
      done++;
    }
  };

  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!.toFixed(2);
  console.log(
    `${label.padEnd(18)} ops=${done} conc=${CONCURRENCY} shards=${shardCount}  ` +
      `${(done / seconds).toFixed(0)} ops/s  p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`,
  );
}

async function main() {
  const pool = createPool(DATABASE_URL!, { max: CONCURRENCY + 4 });
  await applySchema(pool);
  await pool.query("TRUNCATE budget_node_counters, budget_node_leases, budget_nodes RESTART IDENTITY CASCADE");
  console.log(`\nreservation micro-benchmark — ${TOTAL} ops @ concurrency ${CONCURRENCY}\n`);
  await runScenario(pool, "unsharded (1 row)", 1);
  await runScenario(pool, "sharded (16 rows)", 16);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
