/**
 * Deployment profiles: recommended env flags for single-tenant self-host vs
 * SaaS multi-tenant control plane. Pure — no I/O.
 *
 * Hierarchical budgets + counter sharding are opt-in per tenant (or when
 * measured global-row contention); flat budgets are the default for both profiles.
 */

export type DeployProfile = "selfhost" | "multitenant";

export const DEPLOY_PROFILE_ENV = "MODELGOV_DEPLOY_PROFILE";

/** Env flags a profile sets (values merged into Helm / compose). */
export interface ProfileEnvFlags {
  MODELGOV_DEPLOY_PROFILE: DeployProfile;
  HIERARCHICAL_BUDGETS: "true" | "false";
  MULTI_TENANT_POLICY: "true" | "false";
  POLICY_STORE_ENABLED: "true" | "false";
  DB_RLS_ENABLED: "true" | "false";
  POLICY_CACHE_TTL_MS?: string;
}

export interface DeployProfileCheck {
  severity: "pass" | "warn" | "fail";
  code: string;
  message: string;
  fix?: string;
}

const SELFHOST_FLAGS: ProfileEnvFlags = {
  MODELGOV_DEPLOY_PROFILE: "selfhost",
  HIERARCHICAL_BUDGETS: "false",
  MULTI_TENANT_POLICY: "false",
  POLICY_STORE_ENABLED: "false",
  DB_RLS_ENABLED: "false",
};

const MULTITENANT_FLAGS: ProfileEnvFlags = {
  MODELGOV_DEPLOY_PROFILE: "multitenant",
  HIERARCHICAL_BUDGETS: "false",
  MULTI_TENANT_POLICY: "true",
  POLICY_STORE_ENABLED: "true",
  DB_RLS_ENABLED: "true",
  POLICY_CACHE_TTL_MS: "30000",
};

/** Recommended env for a deployment profile (flat budgets default). */
export function profileEnvFlags(profile: DeployProfile): ProfileEnvFlags {
  return profile === "multitenant" ? { ...MULTITENANT_FLAGS } : { ...SELFHOST_FLAGS };
}

/**
 * Resolve the active profile from env. Explicit `MODELGOV_DEPLOY_PROFILE` wins;
 * otherwise infer multitenant when per-tenant policy is on.
 */
export function resolveDeployProfile(
  env: Record<string, string | undefined>,
): DeployProfile | undefined {
  const explicit = env[DEPLOY_PROFILE_ENV];
  if (explicit === "selfhost" || explicit === "multitenant") return explicit;
  if (env.MULTI_TENANT_POLICY === "true") return "multitenant";
  if (env.POLICY_STORE_ENABLED === "true" && env.DB_RLS_ENABLED === "true") {
    return "multitenant";
  }
  return undefined;
}

function flagMismatch(
  env: Record<string, string | undefined>,
  key: keyof ProfileEnvFlags,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false;
  const actual = env[key];
  if (actual === undefined) return false;
  return String(actual) !== expected;
}

/** Posture checks for doctor / boot. Fails are enforced in production when asserted. */
export function deployProfileChecks(
  env: Record<string, string | undefined>,
  opts: { production?: boolean } = {},
): DeployProfileCheck[] {
  const checks: DeployProfileCheck[] = [];
  const production = opts.production ?? env.MODELGOV_PRODUCTION === "true";
  const profile = resolveDeployProfile(env);

  const push = (
    severity: DeployProfileCheck["severity"],
    code: string,
    message: string,
    fix?: string,
  ) => {
    checks.push({ severity, code, message, fix });
  };

  if (!profile) {
    if (env.MULTI_TENANT_POLICY === "true" && env.DB_RLS_ENABLED !== "true") {
      push(
        production ? "fail" : "warn",
        "multitenant_rls",
        "MULTI_TENANT_POLICY without DB_RLS_ENABLED — use a non-owner DB role for defense-in-depth",
        "Set DB_RLS_ENABLED=true and connect as a non-owner role (see docs/design/multi-tenancy.md)",
      );
    }
    if (env.MULTI_TENANT_POLICY === "true" && env.POLICY_STORE_ENABLED !== "true") {
      push(
        production ? "fail" : "warn",
        "multitenant_policy_store",
        "MULTI_TENANT_POLICY requires POLICY_STORE_ENABLED=true",
        "Set POLICY_STORE_ENABLED=true",
      );
    }
    return checks;
  }

  const expected = profileEnvFlags(profile);

  if (profile === "multitenant") {
    if (env.POLICY_STORE_ENABLED !== "true") {
      push(
        "fail",
        "multitenant_policy_store",
        "multitenant profile requires POLICY_STORE_ENABLED=true",
        "Set POLICY_STORE_ENABLED=true or use deployProfile: selfhost",
      );
    } else {
      push("pass", "multitenant_policy_store", "POLICY_STORE_ENABLED=true");
    }

    if (env.MULTI_TENANT_POLICY !== "true") {
      push(
        "fail",
        "multitenant_policy",
        "multitenant profile requires MULTI_TENANT_POLICY=true",
        "Set MULTI_TENANT_POLICY=true",
      );
    } else {
      push("pass", "multitenant_policy", "MULTI_TENANT_POLICY=true");
    }

    if (env.DB_RLS_ENABLED !== "true") {
      push(
        "fail",
        "multitenant_rls",
        "multitenant profile requires DB_RLS_ENABLED=true",
        "Set DB_RLS_ENABLED=true and use a non-owner DATABASE_URL role",
      );
    } else {
      push("pass", "multitenant_rls", "DB_RLS_ENABLED=true");
    }

    if (production && !env.REDIS_URL) {
      push(
        "warn",
        "multitenant_redis",
        "SaaS deploy without REDIS_URL — rate limits are per-replica only",
        "Configure managed Redis (REDIS_URL) for multi-replica installs",
      );
    } else if (env.REDIS_URL) {
      push("pass", "multitenant_redis", "REDIS_URL configured");
    }

    if (env.HIERARCHICAL_BUDGETS === "true") {
      push(
        "warn",
        "hierarchical_platform",
        "HIERARCHICAL_BUDGETS enabled platform-wide — prefer per-tenant trees; shard top nodes only when benchmarked",
        "See docs/deployment/benchmarks.md; keep flat path until nested caps or contention require hierarchy",
      );
    } else {
      push(
        "pass",
        "budget_path",
        "Flat budgets (default) — enable hierarchical per hot tenant when needed",
      );
    }
  }

  if (profile === "selfhost") {
    push("pass", "deploy_profile", "selfhost profile — flat budgets, single-tenant policy file");

    if (env.MULTI_TENANT_POLICY === "true") {
      push(
        "warn",
        "selfhost_multitenant_mismatch",
        "selfhost profile but MULTI_TENANT_POLICY=true",
        "Set MODELGOV_DEPLOY_PROFILE=multitenant or disable MULTI_TENANT_POLICY",
      );
    }
    if (env.POLICY_STORE_ENABLED === "true") {
      push(
        "warn",
        "selfhost_policy_store",
        "selfhost profile but POLICY_STORE_ENABLED=true",
        "Use file-based policy or set MODELGOV_DEPLOY_PROFILE=multitenant",
      );
    }
    if (env.HIERARCHICAL_BUDGETS === "true") {
      push(
        "warn",
        "selfhost_hierarchical",
        "HIERARCHICAL_BUDGETS on self-host — enable only for nested caps or measured global-row contention",
        "Benchmark with scripts/bench-node-reservation.ts before platform-wide hierarchy",
      );
    }
  }

  // Flag drift vs declared profile (when explicit profile env is set).
  if (env[DEPLOY_PROFILE_ENV]) {
    for (const [key, value] of Object.entries(expected)) {
      if (key === DEPLOY_PROFILE_ENV || value === undefined) continue;
      if (flagMismatch(env, key as keyof ProfileEnvFlags, value)) {
        push(
          production ? "fail" : "warn",
          "profile_drift",
          `${key}=${env[key] ?? "(unset)"} does not match ${profile} profile (expected ${value})`,
          `Align ${key} with deploy/helm/modelgov/values-${profile}.yaml`,
        );
      }
    }
  }

  return checks;
}

/** Throw when production posture fails deploy-profile checks. */
export function assertDeployProfilePosture(
  env: Record<string, string | undefined>,
): void {
  if (env.MODELGOV_PRODUCTION !== "true") return;
  const failures = deployProfileChecks(env, { production: true }).filter(
    (c) => c.severity === "fail",
  );
  if (failures.length === 0) return;
  const detail = failures.map((c) => `${c.code}: ${c.message}`).join("; ");
  throw new Error(`Deploy profile posture failed: ${detail}`);
}
