import { loadDatabaseEnv } from "./config/env";
import { applySchema } from "./db/init";
import { createPool, resolveSsl } from "./db/pool";
import { applyTenantRls } from "./db/rls";

async function main(): Promise<void> {
  const env = loadDatabaseEnv();
  const pool = createPool(env.DATABASE_URL, {
    ssl: resolveSsl(env.DATABASE_SSL, env.DATABASE_SSL_CA),
    // Disable statement/query timeouts for migrations. DDL on a large table (an
    // index build, a table rewrite) can legitimately run longer than the 30s
    // runtime default, and the blocking pg_advisory_lock wait when replicas boot
    // together must not be killed mid-wait either. Runtime pools keep the 30s
    // bound; only this one-shot migrate process runs unbounded.
    statementTimeoutMillis: 0,
  });
  try {
    await applySchema(pool);
    console.log("modelgov schema applied");
    // Opt-in tenant-isolation RLS on config_versions (kept OUT of the auto
    // migration chain so it never surprises a non-owner-role deploy).
    if (env.DB_RLS_ENABLED === "true") {
      await applyTenantRls(pool);
      console.log("config_versions tenant-isolation RLS applied (DB_RLS_ENABLED=true)");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Redact any connection string (with password) that a pg error may embed.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(msg.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]"));
  process.exit(1);
});
