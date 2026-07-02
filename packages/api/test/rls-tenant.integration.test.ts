import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, withTenantContext, type Pool } from "../src/db/pool";
import { applyTenantRls, dropTenantRls } from "../src/db/rls";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  saveConfigVersion,
  setConfigVersionsRls,
} from "../src/modules/policy/repo";

const DATABASE_URL = process.env.DATABASE_URL;
const APP_ROLE = "ai_guard_rls_test";
const APP_PASS = "rls-test-pass";

const yaml = (monthlyUsd: number): string => `
project: { name: t, environment: test }
budgets:
  global: { monthly_usd: ${monthlyUsd}, hard_stop_at_percent: 100 }
  by_user_type:
    logged_in: { daily_usd: 1, daily_requests: 10, models: [cheap] }
features:
  support_chat: { model_class: cheap, max_tokens: 100, safety: dev }
model_classes:
  cheap: { primary: openai/gpt-4o-mini }
safety: { preset: dev }
`;

function roleUrl(base: string): string {
  const u = new URL(base);
  u.username = APP_ROLE;
  u.password = APP_PASS;
  return u.toString();
}

describe.skipIf(!DATABASE_URL)("config_versions RLS tenant isolation (integration)", () => {
  let owner: Pool; // table owner (bypasses RLS)
  let app: Pool; // non-owner app role (subject to RLS)

  beforeAll(async () => {
    owner = createPool(DATABASE_URL!);
    await applySchema(owner);
    await applyTenantRls(owner);

    // Recreate a clean non-owner login role with just the privileges the app needs.
    await owner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          DROP OWNED BY ${APP_ROLE};
          DROP ROLE ${APP_ROLE};
        END IF;
      END $$;
    `);
    await owner.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASS}'`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON config_versions TO ${APP_ROLE}`);
    await owner.query(`GRANT USAGE, SELECT ON SEQUENCE config_versions_id_seq TO ${APP_ROLE}`);

    app = createPool(roleUrl(DATABASE_URL!));
  });

  afterAll(async () => {
    setConfigVersionsRls(false); // never leak the global into other test files
    await app?.end().catch(() => {});
    await dropTenantRls(owner).catch(() => {});
    await owner.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        DROP OWNED BY ${APP_ROLE};
        DROP ROLE ${APP_ROLE};
      END IF;
    END $$;`).catch(() => {});
    await owner.end();
  });

  beforeEach(async () => {
    setConfigVersionsRls(false);
    await owner.query("TRUNCATE config_versions");
    // Seed one active version per tenant, as the owner (RLS bypassed).
    const a = await saveConfigVersion(owner, { yaml: yaml(111), tenantId: "tenant-a" });
    await activateConfigVersion(owner, a.id, "tenant-a");
    const b = await saveConfigVersion(owner, { yaml: yaml(222), tenantId: "tenant-b" });
    await activateConfigVersion(owner, b.id, "tenant-b");
  });

  it("owner bypasses RLS and sees every tenant's rows", async () => {
    const { rows } = await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM config_versions");
    expect(rows[0]?.count).toBe(2);
  });

  it("non-owner without a tenant context is fail-closed (sees nothing)", async () => {
    const { rows } = await app.query<{ count: number }>("SELECT count(*)::int AS count FROM config_versions");
    expect(rows[0]?.count).toBe(0);
  });

  it("non-owner sees only its own tenant inside withTenantContext", async () => {
    const a = await withTenantContext(app, "tenant-a", (c) =>
      c.query<{ tenant_id: string }>("SELECT tenant_id FROM config_versions"),
    );
    expect(a.rows.map((r) => r.tenant_id)).toEqual(["tenant-a"]);

    const b = await withTenantContext(app, "tenant-b", (c) =>
      c.query<{ tenant_id: string }>("SELECT tenant_id FROM config_versions"),
    );
    expect(b.rows.map((r) => r.tenant_id)).toEqual(["tenant-b"]);
  });

  it("repo reads through RLS resolve each tenant's active version via the non-owner role", async () => {
    setConfigVersionsRls(true); // runtime wiring: repo sets app.current_tenant
    expect((await getActiveConfigVersion(app, "tenant-a"))?.config.budgets.global.monthlyUsd).toBe(111);
    expect((await getActiveConfigVersion(app, "tenant-b"))?.config.budgets.global.monthlyUsd).toBe(222);
    // A tenant with no rows visible to it resolves to null (not another tenant's).
    expect(await getActiveConfigVersion(app, "tenant-c")).toBeNull();
  });

  it("non-owner cannot write outside its tenant (WITH CHECK)", async () => {
    setConfigVersionsRls(true);
    // Inserting a tenant-b row while scoped to tenant-a violates the policy.
    await expect(
      withTenantContext(app, "tenant-a", (c) =>
        c.query(
          "INSERT INTO config_versions (tenant_id, yaml_text, checksum) VALUES ($1,$2,$3)",
          ["tenant-b", yaml(999), "deadbeef"],
        ),
      ),
    ).rejects.toThrow();
  });
});
