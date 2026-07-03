/**
 * API latency micro-benchmark for /v1/explain and /v1/chat.
 * Run against a live deployment (see docs/deployment/benchmarks.md).
 *
 * Usage:
 *   MODELGOV_URL=http://127.0.0.1:3000 MODELGOV_API_KEY=... npx tsx scripts/bench-api-latency.ts
 */
const BASE = process.env.MODELGOV_URL ?? "http://127.0.0.1:3000";
const API_KEY = process.env.MODELGOV_API_KEY ?? "sk-modelgov-api-local";
const OPS = Number(process.env.BENCH_OPS ?? 500);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 16);

interface Sample {
  ms: number;
  status: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function oneExplain(): Promise<Sample> {
  const start = performance.now();
  const res = await fetch(`${BASE}/v1/explain`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: `bench_${Math.random().toString(36).slice(2, 8)}`,
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "cheap",
    }),
  });
  return { ms: performance.now() - start, status: res.status };
}

async function oneChat(): Promise<Sample> {
  const start = performance.now();
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: `bench_${Math.random().toString(36).slice(2, 8)}`,
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "cheap",
      messages: [{ role: "user", content: "Say ok" }],
    }),
  });
  return { ms: performance.now() - start, status: res.status };
}

async function runBatch(label: string, fn: () => Promise<Sample>): Promise<void> {
  const samples: Sample[] = [];
  let inFlight = 0;
  let next = 0;

  await new Promise<void>((resolve, reject) => {
    const kick = () => {
      while (inFlight < CONCURRENCY && next < OPS) {
        inFlight++;
        next++;
        fn()
          .then((s) => samples.push(s))
          .catch(reject)
          .finally(() => {
            inFlight--;
            if (samples.length >= OPS && inFlight === 0) resolve();
            else kick();
          });
      }
    };
    kick();
  });

  const elapsed = samples.reduce((a, s) => a + s.ms, 0) / 1000;
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.status >= 500).length;
  const wall = latencies.length ? (latencies[latencies.length - 1]! / 1000) * (samples.length / CONCURRENCY) : 0;

  console.log(`\n${label} (${OPS} ops, concurrency ${CONCURRENCY})`);
  console.log(`  throughput: ~${(samples.length / Math.max(wall, elapsed / CONCURRENCY)).toFixed(0)} req/s (approx)`);
  console.log(`  p50: ${percentile(latencies, 50).toFixed(1)} ms`);
  console.log(`  p95: ${percentile(latencies, 95).toFixed(1)} ms`);
  console.log(`  p99: ${percentile(latencies, 99).toFixed(1)} ms`);
  console.log(`  5xx: ${((errors / samples.length) * 100).toFixed(2)}%`);
}

async function main(): Promise<void> {
  console.log(`Benchmark target: ${BASE}`);
  console.log(`Commit: ${process.env.GITHUB_SHA ?? "local"}`);
  await runBatch("POST /v1/explain", oneExplain);
  await runBatch("POST /v1/chat (mock/unavailable provider ok)", oneChat);
  console.log("\nRecord results in docs/deployment/benchmarks.md baseline section.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
