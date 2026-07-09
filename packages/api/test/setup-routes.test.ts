import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerSetupRoutes } from "../src/modules/setup/routes";

// These tests deliberately never set `useCloud: true`, so the Docker-socket
// proxy-restart path is never exercised — a test run on a machine with a live
// `modelgov` stack must not restart a real container.

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "modelgov-setup-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function buildApp(opts: {
  permissions: string[];
  projectRoot: string;
  enabled?: boolean;
  production?: boolean;
}): FastifyInstance {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { ctx: unknown }).ctx = {
      requestId: "test",
      tenantId: null,
      permissions: opts.permissions,
    };
  });
  registerSetupRoutes(app, {
    enabled: opts.enabled ?? true,
    projectRoot: opts.projectRoot,
    production: opts.production ?? false,
  });
  return app;
}

async function post(app: FastifyInstance, payload: Record<string, unknown>) {
  return await app.inject({ method: "POST", url: "/v1/setup/secrets", payload });
}

describe("POST /v1/setup/secrets", () => {
  it("403s without policy:write", async () => {
    const app = buildApp({ permissions: ["usage:read"], projectRoot: tempRoot() });
    const res = await post(app, { secrets: { OPENAI_API_KEY: "sk-x" } });
    expect(res.statusCode).toBe(403);
  });

  it("400s when every provided secret is blank", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot() });
    const res = await post(app, { secrets: { OPENAI_API_KEY: "   " } });
    expect(res.statusCode).toBe(400);
  });

  it("merges non-empty secrets into the project .env and reports saved keys", async () => {
    const root = tempRoot();
    const app = buildApp({ permissions: ["policy:write"], projectRoot: root });
    const res = await post(app, {
      secrets: { OPENAI_API_KEY: "sk-real", ANTHROPIC_API_KEY: "" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.savedKeys).toEqual(["OPENAI_API_KEY"]); // blank one filtered out
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("OPENAI_API_KEY=sk-real");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
  });

  it("writes the generated LiteLLM config and points .env at it", async () => {
    const root = tempRoot();
    const app = buildApp({ permissions: ["policy:write"], projectRoot: root });
    const res = await post(app, {
      secrets: { OPENAI_API_KEY: "sk-real" },
      litellmYaml: "model_list:\n  - model_name: cheap\n",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.litellmConfigPath).toBe("litellm_config.generated.yaml");
    expect(existsSync(join(root, "litellm_config.generated.yaml"))).toBe(true);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "LITELLM_CONFIG_PATH=./litellm_config.generated.yaml",
    );
  });

  it("is not registered when disabled", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot(), enabled: false });
    const res = await post(app, { secrets: { OPENAI_API_KEY: "sk-x" } });
    expect(res.statusCode).toBe(404);
  });

  it("is not registered in production", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot(), production: true });
    const res = await post(app, { secrets: { OPENAI_API_KEY: "sk-x" } });
    expect(res.statusCode).toBe(404);
  });
});
