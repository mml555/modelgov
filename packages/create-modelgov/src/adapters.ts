import type { Template } from "./templates";

// Framework adapters generate an SDK client + an example route that shows the
// boundary: the host app authenticates/authorizes, THEN calls Modelgov. TS
// frameworks use @modelgov/sdk; FastAPI uses the Python modelgov.

export type Framework = "nextjs" | "express" | "fastify" | "fastapi" | "none";

export interface AdapterOutput {
  /** Generated files, path → content (relative to the project root). */
  files: Record<string, string>;
  /** Package(s) the user must install for the generated code. */
  installHint: string;
}

const BOUNDARY = [
  "// Boundary: your app decides WHO the user is and whether they may do this",
  "// product action (auth + RBAC). Modelgov decides whether the AI call is",
  "// allowed (budget / model access / safety). Do your auth check first.",
].join("\n");

function tsClient(): string {
  return `import { createModelgovClient } from "@modelgov/sdk";

// One client for the whole app. Point MODELGOV_URL at your Modelgov deployment.
export const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3000",
  apiKey: process.env.MODELGOV_API_KEY ?? "",
});
`;
}

function nextRoute(t: Template): string {
  return `import { NextResponse } from "next/server";
import { PolicyBlockedError, SafetyBlockedError } from "@modelgov/sdk";
import { ai } from "@/lib/modelgov";
// import { getSession } from "@/lib/auth"; // your existing auth

${BOUNDARY}
export async function POST(request: Request): Promise<NextResponse> {
  // const session = await getSession(request);
  // if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { message } = (await request.json()) as { message?: string };
  if (!message) return NextResponse.json({ error: "message_required" }, { status: 400 });

  try {
    const res = await ai.chat({
      userId: /* session.userId */ "demo-user",
      userType: "${t.exampleUserType}",
      feature: "${t.primaryFeature}",
      messages: [{ role: "user", content: message }],
    });
    return NextResponse.json({ reply: res.message.content, requestId: res.requestId, decision: res.decision });
  } catch (err) {
    if (err instanceof SafetyBlockedError) return NextResponse.json({ error: "safety_blocked", reasonCode: err.reasonCode }, { status: 400 });
    if (err instanceof PolicyBlockedError) return NextResponse.json({ error: "policy_blocked", reasonCode: err.reasonCode, budgetRemaining: err.budgetRemaining }, { status: 429 });
    throw err;
  }
}
`;
}

function expressRoute(t: Template): string {
  return `import { Router } from "express";
import { PolicyBlockedError, SafetyBlockedError } from "@modelgov/sdk";
import { ai } from "../modelgov";

export const aiRouter = Router();

${BOUNDARY}
aiRouter.post("/ai", async (req, res) => {
  // if (!req.user) return res.status(401).json({ error: "unauthorized" }); // your auth
  const { message } = req.body as { message?: string };
  if (!message) return res.status(400).json({ error: "message_required" });

  try {
    const out = await ai.chat({
      userId: /* req.user.id */ "demo-user",
      userType: "${t.exampleUserType}",
      feature: "${t.primaryFeature}",
      messages: [{ role: "user", content: message }],
    });
    res.json({ reply: out.message.content, requestId: out.requestId, decision: out.decision });
  } catch (err) {
    if (err instanceof SafetyBlockedError) return res.status(400).json({ error: "safety_blocked", reasonCode: err.reasonCode });
    if (err instanceof PolicyBlockedError) return res.status(429).json({ error: "policy_blocked", reasonCode: err.reasonCode, budgetRemaining: err.budgetRemaining });
    throw err;
  }
});
`;
}

function fastifyRoute(t: Template): string {
  return `import type { FastifyInstance } from "fastify";
import { PolicyBlockedError, SafetyBlockedError } from "@modelgov/sdk";
import { ai } from "../modelgov";

${BOUNDARY}
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.post("/ai", async (request, reply) => {
    // your auth/RBAC first (request.user, etc.)
    const { message } = request.body as { message?: string };
    if (!message) return reply.code(400).send({ error: "message_required" });

    try {
      const out = await ai.chat({
        userId: "demo-user",
        userType: "${t.exampleUserType}",
        feature: "${t.primaryFeature}",
        messages: [{ role: "user", content: message }],
      });
      return { reply: out.message.content, requestId: out.requestId, decision: out.decision };
    } catch (err) {
      if (err instanceof SafetyBlockedError) return reply.code(400).send({ error: "safety_blocked", reasonCode: err.reasonCode });
      if (err instanceof PolicyBlockedError) return reply.code(429).send({ error: "policy_blocked", reasonCode: err.reasonCode });
      throw err;
    }
  });
}
`;
}

function fastapiRoute(t: Template): string {
  return `from fastapi import APIRouter, HTTPException
from modelgov import ModelgovClient, PolicyBlockedError, SafetyBlockedError
import os

router = APIRouter()
ai = ModelgovClient(
    base_url=os.environ.get("MODELGOV_URL", "http://localhost:3000"),
    api_key=os.environ.get("MODELGOV_API_KEY", ""),
)

# Boundary: your app authenticates/authorizes the user first; Modelgov enforces
# AI policy (budget / model access / safety).
@router.post("/ai")
def ai_route(body: dict):
    message = body.get("message")
    if not message:
        raise HTTPException(status_code=400, detail="message_required")
    try:
        result = ai.chat(
            user_id="demo-user",
            user_type="${t.exampleUserType}",
            feature="${t.primaryFeature}",
            messages=[{"role": "user", "content": message}],
        )
        return result
    except SafetyBlockedError as e:
        raise HTTPException(status_code=400, detail={"error": "safety_blocked", "reasonCode": e.reason_code})
    except PolicyBlockedError as e:
        raise HTTPException(status_code=429, detail={"error": "policy_blocked", "reasonCode": e.reason_code})
`;
}

// NOTE: `@modelgov/sdk` and `modelgov` are not yet published to npm/PyPI, so
// the `npm i` / `pip install` hints below only work once they are. Until then,
// install from source (see docs/self-host.md) — e.g. a workspace/path dependency
// on `packages/sdk-typescript`, or `pip install -e packages/sdk-python`.
export function adapterFor(framework: Framework, template: Template): AdapterOutput {
  switch (framework) {
    case "nextjs":
      return {
        files: { "lib/modelgov.ts": tsClient(), "app/api/ai/route.ts": nextRoute(template) },
        installHint: "npm i @modelgov/sdk (when published; until then install from source — see docs/self-host.md)",
      };
    case "express":
      return {
        files: { "src/modelgov.ts": tsClient(), "src/routes/ai.ts": expressRoute(template) },
        installHint: "npm i express, plus @modelgov/sdk (when published; until then install from source — see docs/self-host.md)",
      };
    case "fastify":
      return {
        files: { "src/modelgov.ts": tsClient(), "src/routes/ai.ts": fastifyRoute(template) },
        installHint: "npm i fastify, plus @modelgov/sdk (when published; until then install from source — see docs/self-host.md)",
      };
    case "fastapi":
      return {
        files: { "app/routes/ai.py": fastapiRoute(template) },
        installHint: "pip install fastapi, plus modelgov (when published; until then install from source — see docs/self-host.md)",
      };
    case "none":
      return { files: {}, installHint: "" };
  }
}
