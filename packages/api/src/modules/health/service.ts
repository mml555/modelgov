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
