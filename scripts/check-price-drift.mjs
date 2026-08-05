// Compare Modelgov's provider price registry against LiteLLM's actively
// maintained price database.
//
// Why this exists: the registry hardcodes per-1k rates. If a provider changes
// pricing, nothing here fails — budgets still bind, but recorded spend silently
// diverges from the real bill, which is the one thing a cost-governance gateway
// must not get wrong. This turns "remember to review prices" into a check.
//
//   node scripts/check-price-drift.mjs                    # fetch the current table
//   node scripts/check-price-drift.mjs --file prices.json # offline / pinned copy
//   docker exec <litellm> cat /app/model_prices_and_context_window.json > p.json
//
// Exit 1 only on a real mismatch. Models the table doesn't know (Modelgov uses
// friendly aliases like `anthropic/claude-haiku` that are not provider model
// IDs) are reported as UNVERIFIED, not failures — a missing entry is not drift.
//
// Not wired into `pnpm verify`: upstream prices change on someone else's
// schedule, and a blocking gate would red main for reasons unrelated to a PR.
// Run it per release, or on a cron that opens an issue.

import { readFileSync } from "node:fs";
import { PROVIDER_REGISTRY } from "../packages/policy-engine/src/index.ts";

const PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/** Relative difference above which we call it drift (floating-point noise below). */
const TOLERANCE = 0.005;

/**
 * Registry keys whose NAME collides with a different upstream model. These are
 * tier aliases, not provider model IDs, so the upstream row describes something
 * else entirely and comparing them is apples-to-oranges. Each entry needs a
 * reason — this list suppresses a real signal, so it must stay short and earned.
 */
const ALIAS_COLLISIONS = new Map([
  [
    "gemini/gemini-pro",
    "Modelgov alias for the Gemini *pro tier* (priced as 1.5 Pro, matching our " +
      "vertex_ai/gemini-1.5-pro row). Upstream 'gemini/gemini-pro' is legacy " +
      "Gemini 1.0 Pro at a much lower rate.",
  ],
]);

const fileArg = process.argv.indexOf("--file");
async function loadTable() {
  if (fileArg !== -1) {
    const path = process.argv[fileArg + 1];
    if (!path) throw new Error("--file needs a path");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const res = await fetch(PRICE_URL);
  if (!res.ok) throw new Error(`fetching ${PRICE_URL} failed: ${res.status}`);
  return await res.json();
}

/**
 * Modelgov keys are `<provider>/<model>`. LiteLLM keys are sometimes bare
 * (`gpt-4o-mini`), sometimes prefixed (`gemini/gemini-2.0-flash`), sometimes
 * vendor-qualified (`azure/gpt-4o`). Try the plausible spellings; a miss means
 * "cannot verify", never "wrong".
 */
function lookup(table, key) {
  const bare = key.slice(key.indexOf("/") + 1);
  for (const candidate of [key, bare, `openai/${bare}`]) {
    if (table[candidate]) return { entry: table[candidate], matchedAs: candidate };
  }
  return null;
}

const table = await loadTable();
const drift = [];
const unverified = [];
const skipped = [];
let verified = 0;

for (const spec of Object.values(PROVIDER_REGISTRY)) {
  for (const [model, price] of Object.entries(spec.prices ?? {})) {
    const collision = ALIAS_COLLISIONS.get(model);
    if (collision) {
      skipped.push({ model, reason: collision });
      continue;
    }
    const hit = lookup(table, model);
    if (!hit) {
      unverified.push(model);
      continue;
    }
    const theirIn = (hit.entry.input_cost_per_token ?? 0) * 1000;
    const theirOut = (hit.entry.output_cost_per_token ?? 0) * 1000;
    if (theirIn === 0 && theirOut === 0) {
      unverified.push(`${model} (no price upstream)`);
      continue;
    }
    const rel = (a, b) => (b === 0 ? (a === 0 ? 0 : 1) : Math.abs(a - b) / b);
    const dIn = rel(price.inputPer1k, theirIn);
    const dOut = rel(price.outputPer1k, theirOut);
    if (dIn > TOLERANCE || dOut > TOLERANCE) {
      drift.push({ model, matchedAs: hit.matchedAs, ours: price, theirs: { theirIn, theirOut }, dIn, dOut });
    } else {
      verified++;
    }
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `price drift check — ${verified} verified, ${drift.length} drifted, ` +
    `${unverified.length} unverified, ${skipped.length} skipped\n`,
);

if (drift.length) {
  console.log("DRIFTED (registry disagrees with the upstream price table):");
  for (const d of drift) {
    console.log(`  ${d.model}  [upstream key: ${d.matchedAs}]`);
    console.log(`      input /1k: ours $${d.ours.inputPer1k}  upstream $${d.theirs.theirIn}  (${pct(d.dIn)} off)`);
    console.log(`      output/1k: ours $${d.ours.outputPer1k}  upstream $${d.theirs.theirOut}  (${pct(d.dOut)} off)`);
  }
  console.log("");
}
if (skipped.length) {
  console.log("SKIPPED (alias collides with a different upstream model):");
  for (const s2 of skipped) console.log(`  ${s2.model}\n      ${s2.reason}`);
  console.log("");
}
if (unverified.length) {
  console.log("UNVERIFIED (alias not in the upstream table — check by hand):");
  for (const u of unverified) console.log(`  ${u}`);
  console.log("");
}

if (drift.length) {
  console.error(`price drift: ${drift.length} model(s) disagree with upstream. Update packages/policy-engine/src/providers.ts.`);
  process.exit(1);
}
console.log("no drift detected in the models upstream can confirm.");
