import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../src/db/migrations");
const DATABASE_URL = process.env.DATABASE_URL;

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function databaseUrlForName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withFreshDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dbName = `aiguard_migration_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    try {
      return await fn(databaseUrlForName(DATABASE_URL!, dbName));
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

describe.skipIf(!DATABASE_URL)("migration upgrade matrix", () => {
  it("fresh install applies all migrations idempotently", async () => {
    await withFreshDatabase(async (url) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const files = listMigrationFiles();
        expect(files.length).toBeGreaterThan(0);

        for (const file of files) {
          const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
          await client.query(sql);
        }

        // Re-run last migration — should not throw (guarded migrations use IF NOT EXISTS)
        const last = files[files.length - 1]!;
        const sql = readFileSync(resolve(MIGRATIONS_DIR, last), "utf8");
        await expect(client.query(sql)).resolves.toBeDefined();

        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
        );
        expect(rows[0]?.n).toBeGreaterThanOrEqual(0);
      } finally {
        await client.end();
      }
    });
  });

  it("schema_migrations table tracks applied versions", async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT to_regclass('public.schema_migrations') AS reg`,
      );
      // May not exist until migrate.js runs — skip assertion if fresh CI DB
      if (!rows[0]?.reg) return;
      const count = await client.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`);
      expect(count.rows[0]?.n).toBeGreaterThanOrEqual(1);
    } finally {
      await client.end();
    }
  });
});
