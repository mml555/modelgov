import { providerOf } from "@modelgov/policy-engine";
import type { Pool } from "pg";
import { pingDatabase } from "./repo";

export interface HealthDeps {
  pool: Pool;
  litellmBaseUrl?: string;
  litellmApiKey?: string;
  presidioAnalyzerUrl?: string;
  presidioAnonymizerUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Liveness: is this process up and turning its event loop? Deliberately does
 * NOT touch the database — a DB blip must not make liveness probes restart-storm
 * the whole fleet (restarting the app can't fix a DB outage). Dependency health
 * belongs in readiness (`checkReady`).
 */
export function checkHealth(): { status: "ok" } {
  return { status: "ok" };
}

export interface ReadyCheck {
  status: "ready" | "not_ready";
  checks: {
    database: "ok" | "fail";
    litellm: "ok" | "fail" | "skipped";
    presidio: "ok" | "fail" | "skipped";
  };
}

export async function checkReady(deps: HealthDeps): Promise<ReadyCheck> {
  const checks: ReadyCheck["checks"] = {
    database: "fail",
    litellm: deps.litellmBaseUrl ? "fail" : "skipped",
    presidio:
      deps.presidioAnalyzerUrl && deps.presidioAnonymizerUrl ? "fail" : "skipped",
  };

  try {
    await pingDatabase(deps.pool);
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }

  const doFetch = deps.fetchImpl ?? fetch;

  if (deps.litellmBaseUrl) {
    checks.litellm = (await pingUrl(
      doFetch,
      `${deps.litellmBaseUrl.replace(/\/$/, "")}/health`,
      deps.litellmApiKey,
    ))
      ? "ok"
      : "fail";
  }

  if (deps.presidioAnalyzerUrl && deps.presidioAnonymizerUrl) {
    const [a, n] = await Promise.all([
      pingUrl(doFetch, `${deps.presidioAnalyzerUrl.replace(/\/$/, "")}/health`),
      pingUrl(doFetch, `${deps.presidioAnonymizerUrl.replace(/\/$/, "")}/health`),
    ]);
    checks.presidio = a && n ? "ok" : "fail";
  }

  // Readiness gates on the DATABASE only — it's the hard dependency (no budget
  // reservation → every request 500s). LiteLLM/Presidio are reported for
  // visibility but do NOT flip readiness: they fail closed per-request (503),
  // and pulling every replica out of rotation on a transient upstream blip would
  // turn a degradation into a full outage.
  const ready = checks.database === "ok";

  return { status: ready ? "ready" : "not_ready", checks };
}

async function pingUrl(
  fetchImpl: typeof fetch,
  url: string,
  bearer?: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Per-provider health ──────────────────────────────────────────────────────
// LiteLLM's /health live-checks every configured model and returns
// healthy_endpoints / unhealthy_endpoints. /ready only reads res.ok (and must
// stay cheap); this surfaces the body so operators can see WHICH model/provider
// is down without making readiness slow or flappy.

export interface ProviderModelHealth {
  model: string;
  provider: string;
  healthy: boolean;
  /** Provider error message for an unhealthy endpoint, when LiteLLM reports one. */
  error?: string;
}

export interface ProviderHealthResult {
  /** "ok" (all up), "degraded" (some down), "fail" (all down / unreachable), "skipped" (no proxy). */
  status: "ok" | "degraded" | "fail" | "skipped";
  models: ProviderModelHealth[];
}

/** Pull a model string from a LiteLLM health entry, tolerating shape drift across versions. */
function healthEntryModel(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    if (typeof e["model"] === "string") return e["model"];
    if (typeof e["model_name"] === "string") return e["model_name"];
    const lp = e["litellm_params"] as Record<string, unknown> | undefined;
    if (lp && typeof lp["model"] === "string") return lp["model"];
  }
  return "unknown";
}

function parseLiteLLMHealth(body: unknown): ProviderModelHealth[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const healthy = Array.isArray(b["healthy_endpoints"]) ? b["healthy_endpoints"] : [];
  const unhealthy = Array.isArray(b["unhealthy_endpoints"]) ? b["unhealthy_endpoints"] : [];
  const out: ProviderModelHealth[] = [];
  for (const e of healthy) {
    const model = healthEntryModel(e);
    out.push({ model, provider: providerOf(model), healthy: true });
  }
  for (const e of unhealthy) {
    const model = healthEntryModel(e);
    const err = (e as Record<string, unknown> | null)?.["error"];
    out.push({
      model,
      provider: providerOf(model),
      healthy: false,
      ...(typeof err === "string" ? { error: err } : {}),
    });
  }
  return out;
}

/** Fetch + parse LiteLLM's per-model health. Never throws — failures map to status "fail". */
export async function checkProviderHealth(deps: HealthDeps): Promise<ProviderHealthResult> {
  if (!deps.litellmBaseUrl) return { status: "skipped", models: [] };
  const doFetch = deps.fetchImpl ?? fetch;
  let body: unknown;
  try {
    const res = await doFetch(`${deps.litellmBaseUrl.replace(/\/$/, "")}/health`, {
      method: "GET",
      headers: deps.litellmApiKey ? { authorization: `Bearer ${deps.litellmApiKey}` } : {},
      // Looser than /ready's 3s: /health live-pings every provider and can be slow.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { status: "fail", models: [] };
    body = await res.json();
  } catch {
    return { status: "fail", models: [] };
  }
  const models = parseLiteLLMHealth(body);
  const unhealthy = models.filter((m) => !m.healthy).length;
  const status =
    models.length === 0 || unhealthy === 0
      ? "ok"
      : unhealthy === models.length
        ? "fail"
        : "degraded";
  return { status, models };
}
