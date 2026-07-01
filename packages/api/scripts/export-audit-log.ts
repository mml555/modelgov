/**
 * Export the tamper-evident admin audit log for WORM / SIEM ingestion.
 *
 * SOC 2 CC7.2 expects privileged-mutation audit trails to be shipped to an
 * append-only (WORM) or SIEM sink and their integrity checked on a cadence. The
 * `admin_audit_log` table is a hash chain (see 0009_admin_audit_log.sql); this
 * script streams it as JSON Lines and re-verifies the chain end to end.
 *
 *   # Full export to a file, verify the chain (non-zero exit if tampered):
 *   DATABASE_URL=postgres://... pnpm --filter @ai-guard/api audit:export > audit.jsonl
 *
 *   # Incremental export for a nightly WORM ship (only rows after the last id):
 *   DATABASE_URL=postgres://... pnpm --filter @ai-guard/api audit:export -- --since-id 4210
 *
 * Flags:
 *   --since-id <n>   Only export rows with id > n (incremental shipping). Chain
 *                    verification always covers the WHOLE chain regardless.
 *   --batch <n>      Page size for the ascending scan (default 1000).
 *   --no-verify      Skip chain verification (export only).
 *   --out <path>     Write JSONL to a file instead of stdout.
 *
 * Exit codes: 0 = ok, 2 = chain verification failed (tamper detected), 1 = error.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import type { DatabaseSslMode } from "../src/db/pool";
import { createPool, resolveSsl } from "../src/db/pool";
import { verifyAuditChain, type AuditRecord } from "../src/modules/audit/repo";

interface Args {
  sinceId: number;
  batch: number;
  verify: boolean;
  out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { sinceId: 0, batch: 1000, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--since-id") args.sinceId = Number(argv[++i]);
    else if (flag === "--batch") args.batch = Number(argv[++i]);
    else if (flag === "--no-verify") args.verify = false;
    else if (flag === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isFinite(args.sinceId) || args.sinceId < 0) throw new Error("--since-id must be >= 0");
  if (!Number.isInteger(args.batch) || args.batch < 1 || args.batch > 10_000) {
    throw new Error("--batch must be 1..10000");
  }
  return args;
}

interface AuditDbRow {
  id: string;
  created_at: Date;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  prev_hash: string;
  row_hash: string;
}

function toRecord(r: AuditDbRow): AuditRecord {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target ?? undefined,
    metadata: r.metadata,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = createPool(databaseUrl, {
    max: 2,
    ssl: resolveSsl(
      (process.env.DATABASE_SSL as DatabaseSslMode) || "disable",
      process.env.DATABASE_SSL_CA,
    ),
  });

  const sink: WriteStream | NodeJS.WriteStream = args.out
    ? createWriteStream(args.out, { encoding: "utf8" })
    : process.stdout;
  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      sink.write(line, (err) => (err ? reject(err) : resolve()));
    });

  try {
    // Ascending, keyset-paginated by id so the export is stable and memory-bounded
    // even for a large chain (WORM ships are append-only, so ascending is natural).
    let cursor = args.sinceId;
    let exported = 0;
    for (;;) {
      const { rows } = await pool.query<AuditDbRow>(
        `SELECT id, created_at, actor, action, target, metadata, prev_hash, row_hash
         FROM admin_audit_log WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [cursor, args.batch],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        await write(`${JSON.stringify(toRecord(r))}\n`);
        exported++;
        cursor = Number(r.id); // ascending scan: the last row sets the next cursor
      }
    }

    if (args.out) await new Promise<void>((r) => (sink as WriteStream).end(r));

    // Integrity is a whole-chain property — always verify from genesis, even for
    // an incremental (--since-id) export.
    let exitCode = 0;
    if (args.verify) {
      const result = await verifyAuditChain(pool);
      if (result.ok) {
        process.stderr.write(`chain OK: ${result.rows} rows verified; ${exported} exported\n`);
      } else {
        process.stderr.write(
          `CHAIN VERIFICATION FAILED: tamper detected at row id ${result.brokenAtId} ` +
            `(${result.rows} rows total); ${exported} exported\n`,
        );
        exitCode = 2;
      }
    } else {
      process.stderr.write(`${exported} rows exported (verification skipped)\n`);
    }
    process.exitCode = exitCode;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`audit export failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
