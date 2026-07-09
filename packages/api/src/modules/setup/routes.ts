import type { FastifyInstance } from "fastify";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { mergeEnvFile } from "./envFile";

const GENERATED_LITELLM_CONFIG = "litellm_config.generated.yaml";

const secretsBodySchema = z.object({
  secrets: z.record(z.string(), z.string()),
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
      Object.entries(parsed.data.secrets).filter(([, v]) => v.trim().length > 0),
    );
    if (Object.keys(filtered).length === 0) {
      return sendError(reply, 400, "invalid_request", {}, "No secrets provided");
    }

    const envPath = `${deps.projectRoot}/.env`;
    mergeEnvFile(envPath, filtered);

    let litellmConfigPath: string | undefined;
    if (parsed.data.litellmYaml) {
      const configPath = resolve(deps.projectRoot, GENERATED_LITELLM_CONFIG);
      writeFileSync(configPath, parsed.data.litellmYaml.endsWith("\n") ? parsed.data.litellmYaml : `${parsed.data.litellmYaml}\n`, "utf8");
      mergeEnvFile(envPath, { LITELLM_CONFIG_PATH: `./${GENERATED_LITELLM_CONFIG}` });
      litellmConfigPath = GENERATED_LITELLM_CONFIG;
    }

    return reply.send({
      ok: true,
      savedKeys: Object.keys(filtered),
      litellmConfigPath,
      nextCommand: parsed.data.useCloud ? "pnpm modelgov reload-providers" : undefined,
      message: parsed.data.useCloud
        ? "Provider keys saved. Run `pnpm modelgov reload-providers` once so the gateway uses them (restarts only the model proxy)."
        : "Provider keys saved.",
    });
  });
}
