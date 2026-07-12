import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { registerSetupRoutes } from "../src/modules/setup/routes";

// Fake pool: no active config version (empty rows) so the merge endpoint returns
// the generated YAML unchanged without needing a real database.
const noActivePool = { query: async () => ({ rows: [] }) } as unknown as Pool;

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
    pool: noActivePool,
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

  it("allows an empty secrets map when a litellm config is provided (Copilot/OAuth provider)", async () => {
    const root = tempRoot();
    const app = buildApp({ permissions: ["policy:write"], projectRoot: root });
    // A subscription/OAuth-device provider has no pasteable key, but still needs
    // its litellm config written and the proxy pointed at it — must not 400.
    const res = await post(app, {
      secrets: {},
      litellmYaml: "model_list:\n  - model_name: github_copilot/gpt-4o\n",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.savedKeys).toEqual([]);
    expect(existsSync(join(root, "litellm_config.generated.yaml"))).toBe(true);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "LITELLM_CONFIG_PATH=./litellm_config.generated.yaml",
    );
  });

  it("still 400s on an empty secrets map with no litellm config (no-op request)", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot() });
    const res = await post(app, { secrets: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a secret value containing a newline (no .env injection)", async () => {
    const root = tempRoot();
    const app = buildApp({ permissions: ["policy:write"], projectRoot: root });
    const res = await post(app, {
      secrets: { OPENAI_API_KEY: "sk-x\nMODELGOV_API_KEY=attacker" },
    });
    expect(res.statusCode).toBe(400);
    if (existsSync(join(root, ".env"))) {
      expect(readFileSync(join(root, ".env"), "utf8")).not.toContain("attacker");
    }
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

// Regression guard for the wizard's cloud-provider path. `/v1/setup/secrets`
// writes the generated LiteLLM config to `$MODELGOV_PROJECT_ROOT/<file>`; the
// litellm container reads its config from a host bind mount. If those are not
// the SAME host file, the wizard writes into the api container only and the
// proxy never sees the new provider (models 404 with ProxyModelNotFoundError).
// This test pins the docker-compose invariant that ties the two together.
describe("docker-compose.simple.yml wizard-config invariant", () => {
  const GENERATED = "litellm_config.generated.yaml";
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const compose = parseYaml(readFileSync(join(repoRoot, "docker-compose.simple.yml"), "utf8")) as {
    services: Record<string, { environment?: Record<string, string>; volumes?: string[] } | undefined>;
  };
  const service = (name: string) => {
    const s = compose.services[name];
    if (!s) throw new Error(`docker-compose.simple.yml is missing the ${name} service`);
    return s;
  };
  // Volume strings embed `${VAR:-default}` (which itself contains ":"), so match
  // on the whole raw entry rather than splitting on ":".
  const litellmVols = service("litellm").volumes ?? [];
  const apiVols = service("api").volumes ?? [];
  const projectRoot = service("api").environment?.MODELGOV_PROJECT_ROOT ?? "/project";

  it("mounts the generated config as litellm's proxy config by default", () => {
    // The default (LITELLM_CONFIG_PATH unset) must be the generated file, mounted
    // to the proxy's config path — not the committed demo file.
    const proxyMount = litellmVols.find((v) => v.includes("/app/config.yaml"));
    expect(proxyMount, "litellm must mount a host file at /app/config.yaml").toBeDefined();
    expect(proxyMount!).toContain(GENERATED);
  });

  it("bind-mounts the generated config into the api container so wizard writes reach the host", () => {
    // The setup route writes `$MODELGOV_PROJECT_ROOT/<file>`; that container path
    // must resolve to the host ./<file> — otherwise the write is container-only.
    const genMount = apiVols.find((v) => v.includes(`${projectRoot}/${GENERATED}`));
    expect(
      genMount,
      `api must bind ./${GENERATED} to ${projectRoot}/${GENERATED} (host-visible wizard write)`,
    ).toBeDefined();
    expect(genMount!.startsWith(`./${GENERATED}:`)).toBe(true);
  });

  it("ties litellm's read path and the api write path to the same host file", () => {
    // Both reference ./litellm_config.generated.yaml on the host: the wizard
    // overwrites it (via the api mount) and a plain litellm restart re-reads it.
    expect(litellmVols.some((v) => v.includes(GENERATED) && v.includes("/app/config.yaml"))).toBe(true);
    expect(apiVols.some((v) => v.startsWith(`./${GENERATED}:`))).toBe(true);
  });
});

describe("GET /v1/setup/status", () => {
  const get = (app: FastifyInstance) => app.inject({ method: "GET", url: "/v1/setup/status" });

  it("reports enabled + not-configured when no real policy is active yet", async () => {
    const app = buildApp({ permissions: ["policy:read"], projectRoot: tempRoot() });
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, configured: false });
  });

  it("is absent (404) when the setup API is disabled — the console reads that as 'no wizard'", async () => {
    const app = buildApp({ permissions: ["policy:read"], projectRoot: tempRoot(), enabled: false });
    const res = await get(app);
    expect(res.statusCode).toBe(404);
  });

  it("is absent (404) in production", async () => {
    const app = buildApp({ permissions: ["policy:read"], projectRoot: tempRoot(), production: true });
    const res = await get(app);
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/setup/policy/merge", () => {
  const mergePost = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/setup/policy/merge", payload });

  it("403s without policy:write", async () => {
    const app = buildApp({ permissions: ["usage:read"], projectRoot: tempRoot() });
    const res = await mergePost(app, { yaml: "project:\n  name: x\n" });
    expect(res.statusCode).toBe(403);
  });

  it("returns the generated YAML unchanged when there is no active version", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot() });
    const yaml = "project:\n  name: x\n";
    const res = await mergePost(app, { yaml });
    expect(res.statusCode).toBe(200);
    expect(res.json().yaml).toContain("name: x");
  });

  it("400s on a missing yaml body", async () => {
    const app = buildApp({ permissions: ["policy:write"], projectRoot: tempRoot() });
    const res = await mergePost(app, {});
    expect(res.statusCode).toBe(400);
  });
});
