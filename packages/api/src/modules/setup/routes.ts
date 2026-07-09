import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { EnvFileError, mergeEnvFile } from "./envFile";

const GENERATED_LITELLM_CONFIG = "litellm_config.generated.yaml";
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 5000;

// Only provider credential env vars may be written via setup — never arbitrary
// keys like DATABASE_URL or MODELGOV_API_KEY. Derived from the provider registry.
const ALLOWED_SECRET_ENV_VARS = new Set(
  Object.values(PROVIDER_REGISTRY).flatMap((p) => p.credentialEnvVars ?? []),
);

const secretsBodySchema = z.object({
  secrets: z.record(
    z.string(),
    z.string().refine((v) => !/[\r\n]/.test(v), "secret values must not contain newlines"),
  ),
  useCloud: z.boolean().optional(),
  litellmYaml: z.string().min(1).optional(),
});

function requireOwner(ctx: RequestContext) {
  if (!ctx.permissions?.includes("policy:write")) {
    return { ok: false as const, status: 403, code: "forbidden", message: "Setup requires policy:write" };
  }
  return { ok: true as const };
}

export interface SetupRouteDeps {
  enabled: boolean;
  projectRoot: string;
  production: boolean;
}

async function dockerRequest<T>(method: string, path: string): Promise<T> {
  return await new Promise<T>((resolvePromise, reject) => {
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path,
        method,
        headers: { host: "docker" },
        timeout: DOCKER_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(body || `Docker API ${res.statusCode}`));
            return;
          }
          resolvePromise((body ? JSON.parse(body) : undefined) as T);
        });
      },
    );
    // Without this, a stuck docker daemon would hang the setup request forever.
    req.on("timeout", () => req.destroy(new Error("Docker API timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function restartComposeService(project: string, service: string): Promise<boolean> {
  try {
    const filters = encodeURIComponent(JSON.stringify({
      label: [
        `com.docker.compose.project=${project}`,
        `com.docker.compose.service=${service}`,
      ],
    }));
    const containers = await dockerRequest<Array<{ Id: string }>>("GET", `/containers/json?filters=${filters}`);
    const id = containers[0]?.Id;
    if (!id) return false;
    await dockerRequest("POST", `/containers/${id}/restart?t=10`);
    return true;
  } catch {
    return false;
  }
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  if (!deps.enabled || deps.production) return;

  app.post("/v1/setup/secrets", {
    schema: {
      tags: ["setup"],
      description: "Dev-only: merge provider secrets into the project .env file.",
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true }, 401: { type: "object" }, 403: { type: "object" } },
    },
  }, async (request, reply) => {
    const auth = requireOwner(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = secretsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {}, parsed.error.message);
    }

    const filtered = Object.fromEntries(
      Object.entries(parsed.data.secrets).filter(
        ([k, v]) => v.trim().length > 0 && ALLOWED_SECRET_ENV_VARS.has(k),
      ),
    );
    if (Object.keys(filtered).length === 0) {
      return sendError(
        reply,
        400,
        "invalid_request",
        {},
        "No recognized provider secrets provided (only provider credential env vars are accepted)",
      );
    }

    const envPath = resolve(deps.projectRoot, ".env");
    let litellmConfigPath: string | undefined;
    try {
      mergeEnvFile(envPath, filtered);

      if (parsed.data.litellmYaml) {
        const configPath = resolve(deps.projectRoot, GENERATED_LITELLM_CONFIG);
        writeFileSync(configPath, parsed.data.litellmYaml.endsWith("\n") ? parsed.data.litellmYaml : `${parsed.data.litellmYaml}\n`, "utf8");
        mergeEnvFile(envPath, { LITELLM_CONFIG_PATH: `./${GENERATED_LITELLM_CONFIG}` });
        litellmConfigPath = GENERATED_LITELLM_CONFIG;
      }
    } catch (e) {
      if (e instanceof EnvFileError) {
        return sendError(reply, 400, "invalid_request", {}, e.message);
      }
      throw e;
    }

    const restarted = parsed.data.useCloud
      ? await restartComposeService("modelgov", "litellm")
      : false;

    return reply.send({
      ok: true,
      savedKeys: Object.keys(filtered),
      litellmConfigPath,
      restarted,
      nextCommand: parsed.data.useCloud && !restarted ? "pnpm modelgov reload-providers" : undefined,
      message: parsed.data.useCloud
        ? (restarted
            ? "Provider keys saved. The model proxy was restarted automatically."
            : "Provider keys saved. Run `pnpm modelgov reload-providers` once so the model proxy uses them.")
        : "Provider keys saved.",
    });
  });
}
