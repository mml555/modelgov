// Concurrency load test for the property production depends on: under real
// concurrent HTTP traffic the gateway must admit EXACTLY what the cap allows —
// never one more — and recorded spend must equal what it told each caller.
//
//   MODELGOV_URL=... MODELGOV_API_KEY=... USER_TYPE=logged_in TOTAL=120 \
//     CONCURRENCY=40 node scripts/loadtest.mjs
//
// Then confirm the ledger agrees:
//   SELECT requests_used, used_usd, reserved_usd FROM budget_counters WHERE key='<userId>';
// reserved_usd must be 0 (no leaked holds) and requests_used must equal `admitted`.
const URL = process.env.MODELGOV_URL ?? "http://localhost:3090";
const KEY = process.env.MODELGOV_API_KEY ?? "sk-modelgov-api-local";
const TOTAL = Number(process.env.TOTAL ?? 120);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);
const USER = process.env.USER_ID ?? `load-${Date.now()}`;
const USER_TYPE = process.env.USER_TYPE ?? "logged_in"; // 50 requests/day, $0.25/day

async function one(i) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${URL}/v1/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId: USER,
        userType: USER_TYPE,
        feature: "support_chat",
        messages: [{ role: "user", content: `load ${i}` }],
      }),
    });
    const ms = performance.now() - t0;
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ms, cost: body?.cost?.actualUsd ?? null, code: body?.error?.code ?? null };
  } catch (err) {
    // Report the error KIND only. A fetch failure's message can embed the target
    // URL, and a URL can carry credentials (http://user:pass@host) — so the raw
    // text never reaches stdout.
    const kind = (err && typeof err === "object" && "cause" in err && err.cause?.code)
      || (err && typeof err === "object" && "name" in err && err.name)
      || "unknown";
    return { status: 0, ms: performance.now() - t0, cost: null, code: String(kind).slice(0, 40) };
  }
}

// Fixed-size worker pool so CONCURRENCY is a real ceiling, not a burst.
const results = [];
let next = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) return;
      results.push(await one(i));
    }
  }),
);
const wall = performance.now() - t0;

const ok = results.filter((r) => r.status === 200);
const denied = results.filter((r) => r.status === 403 || r.status === 429);
const errors = results.filter((r) => r.status !== 200 && r.status !== 403 && r.status !== 429);
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(0);
const charged = ok.reduce((s, r) => s + (r.cost ?? 0), 0);

// The identity fields below are operator-supplied LABELS (a run id and a policy
// tier), never credentials — MODELGOV_API_KEY is read but never printed, and
// error text is reduced to a kind above. userId must be printed: it is the key
// you query budget_counters with afterwards.
// codeql[js/clear-text-logging]
console.log(JSON.stringify({
  userId: USER,
  userType: USER_TYPE,
  total: TOTAL,
  concurrency: CONCURRENCY,
  admitted: ok.length,
  denied: denied.length,
  errors: errors.length,
  errorSample: errors.slice(0, 3),
  deniedCodes: [...new Set(denied.map((d) => d.code))],
  wallMs: Math.round(wall),
  rps: +(TOTAL / (wall / 1000)).toFixed(1),
  latencyMs: { p50: +pct(50), p95: +pct(95), p99: +pct(99), max: +lat.at(-1).toFixed(0) },
  chargedUsdFromResponses: +charged.toFixed(8),
}, null, 2));
