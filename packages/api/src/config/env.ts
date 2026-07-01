import { z } from "zod";
import { expandFileSecrets } from "./secrets";

const baseEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_SSL_CA: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_GUARD_API_KEY: z.string().min(1).optional(),
  AI_GUARD_API_KEYS: z.string().optional(),
  // DB-backed key store (issue/rotate/revoke live via /v1/admin/keys). Static
  // env keys above still work and are used to bootstrap the first keys:admin key.
  API_KEYS_DB_ENABLED: z.enum(["true", "false"]).default("true"),
  API_KEY_CACHE_TTL_MS: z.coerce.number().int().positive().default(10_000),
  // Dynamic policy store: when true, boot loads the active config version from
  // the DB (seeding it from AI_GUARD_CONFIG on first run), instead of always
  // reading the file. Default false keeps file-based deploys unchanged.
  POLICY_STORE_ENABLED: z.enum(["true", "false"]).default("false"),
  // Operator SSO (OIDC). When OIDC_ISSUER + OIDC_JWKS_URI are set, JWT bearer
  // tokens are verified against the IdP and mapped to operator roles.
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_JWKS_URI: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_ROLES_CLAIM: z.string().min(1).default("roles"),
  OIDC_NAME_CLAIM: z.string().min(1).default("sub"),
  // JSON map of IdP role/group value -> Ai-Guard role name(s).
  OIDC_ROLE_MAP: z.string().optional(),
  AI_GUARD_CONFIG: z.string().min(1, "AI_GUARD_CONFIG is required"),
  LITELLM_BASE_URL: z.string().url("LITELLM_BASE_URL must be a URL"),
  LITELLM_MASTER_KEY: z.string().optional(),
  LITELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PRESIDIO_ANALYZER_URL: z.string().url().optional(),
  PRESIDIO_ANONYMIZER_URL: z.string().url().optional(),
  OBSERVABILITY_PROVIDER: z.enum(["none", "langfuse", "otel"]).optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  // OpenTelemetry OTLP/HTTP trace export (provider: otel).
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default("ai-guard"),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(60_000),
  TRUST_PROXY: z.string().optional(),
  CORS_ALLOW_ORIGINS: z.string().optional(),
  METRICS_ENABLED: z.enum(["true", "false"]).default("true"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Rate-limit posture when the Redis backend is unreachable. Default false
  // (fail CLOSED). The atomic budget reserve is the real spend guard, so
  // operators who prefer availability over the limiter can set this true.
  RATE_LIMIT_FAIL_OPEN: z.enum(["true", "false"]).default("false"),
  OBSERVABILITY_CAPTURE_CONTENT: z.enum(["true", "false"]).default("false"),
  IDEMPOTENCY_CAPTURE_CONTENT: z.enum(["true", "false"]).default("false"),
  STRICT_PRICING: z.enum(["true", "false"]).default("false"),
  METRICS_AUTH_TOKEN: z.string().min(1).optional(),
  MAINTENANCE_ENABLED: z.enum(["true", "false"]).default("true"),
  IDEMPOTENCY_STALE_MS: z.coerce.number().int().positive().default(900_000),
  RESERVATION_STALE_MS: z.coerce.number().int().positive().default(900_000),
  // request_logs retention; the maintenance sweep prunes rows older than this.
  REQUEST_LOG_RETENTION_MS: z.coerce.number().int().positive().default(2_592_000_000),
  REDIS_URL: z.string().url().optional(),
  BUDGET_ALERT_WEBHOOK_URL: z.string().url().optional(),
  BUDGET_ALERT_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Allow the budget-alert webhook to point at a private/link-local host. Default
  // false blocks SSRF-adjacent internal targets (169.254.*, 10.*, 127.*, ...).
  BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
});

const envSchema = baseEnvSchema.refine((env) => Boolean(env.AI_GUARD_API_KEY) || Boolean(env.AI_GUARD_API_KEYS), {
  message: "AI_GUARD_API_KEY or AI_GUARD_API_KEYS is required",
  path: ["AI_GUARD_API_KEY"],
});

export type ApiEnv = z.infer<typeof envSchema> & {
  envRefs: Record<string, string | undefined>;
  apiKeys: ApiKeyEnvPrincipal[];
};

export interface ApiKeyEnvPrincipal {
  name: string;
  key?: string;
  keyHash?: string;
  expiresAt?: string;
  projectId?: string;
  environment?: string;
  allowedUserTypes?: readonly string[];
  allowedUserIds?: readonly string[];
  permissions?: readonly string[];
}

const databaseEnvSchema = baseEnvSchema.pick({
  DATABASE_URL: true,
  DATABASE_SSL: true,
  DATABASE_SSL_CA: true,
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

const OPTIONAL_ENV_KEYS = [
  "AI_GUARD_API_KEY",
  "AI_GUARD_API_KEYS",
  "DATABASE_SSL_CA",
  "LITELLM_MASTER_KEY",
  "PRESIDIO_ANALYZER_URL",
  "PRESIDIO_ANONYMIZER_URL",
  "OBSERVABILITY_PROVIDER",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
  "TRUST_PROXY",
  "CORS_ALLOW_ORIGINS",
  "REDIS_URL",
  "BUDGET_ALERT_WEBHOOK_URL",
  "BUDGET_ALERT_WEBHOOK_SECRET",
  "OIDC_ISSUER",
  "OIDC_JWKS_URI",
  "OIDC_AUDIENCE",
  "OIDC_ROLE_MAP",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

function normalizeOptionalEmptyStrings(
  raw: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const normalized = { ...raw };
  for (const key of OPTIONAL_ENV_KEYS) {
    if (normalized[key] === "") {
      delete normalized[key];
    }
  }
  return normalized;
}

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): ApiEnv {
  // Resolve *_FILE secret references (Vault/CSI/K8s/Docker) before validation,
  // so file-mounted secrets satisfy required vars and feed provider-key refs.
  const expanded = expandFileSecrets(raw);
  const normalized = normalizeOptionalEmptyStrings(expanded);
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  return {
    ...parsed.data,
    apiKeys: parseApiKeys(parsed.data),
    envRefs: { ...expanded },
  };
}

export function loadDatabaseEnv(raw: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  const parsed = databaseEnvSchema.safeParse(normalizeOptionalEmptyStrings(expandFileSecrets(raw)));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}

function parseApiKeys(env: z.infer<typeof envSchema>): ApiKeyEnvPrincipal[] {
  if (!env.AI_GUARD_API_KEYS) {
    if (!env.AI_GUARD_API_KEY) {
      throw new Error("Invalid environment: AI_GUARD_API_KEY or AI_GUARD_API_KEYS is required");
    }
    return [
      {
        name: "default",
        key: env.AI_GUARD_API_KEY,
        permissions: ["chat:create"],
      },
    ];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(env.AI_GUARD_API_KEYS);
  } catch {
    throw new Error("Invalid environment: AI_GUARD_API_KEYS must be valid JSON");
  }

  const schema = z.array(
    z
      .object({
        name: z.string().min(1),
        key: z.string().min(1).optional(),
        keyHash: z.string().regex(/^[0-9a-f]{64}$/, "keyHash must be lowercase SHA-256 hex").optional(),
        expiresAt: z.string().datetime().optional(),
        projectId: z.string().min(1).optional(),
        environment: z.string().min(1).optional(),
        allowedUserTypes: z.array(z.string().min(1)).optional(),
        allowedUserIds: z.array(z.string().min(1)).optional(),
        permissions: z.array(z.string().min(1)).optional(),
      })
      .refine((p) => Boolean(p.key) || Boolean(p.keyHash), {
        message: "each API key needs either 'key' or 'keyHash'",
      }),
  ).min(1);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `AI_GUARD_API_KEYS.${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data.map((principal) => ({
    ...principal,
    permissions: principal.permissions ?? ["chat:create"],
  }));
}
