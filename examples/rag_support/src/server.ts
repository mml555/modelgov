import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AiGuardError } from "@ai-guard/sdk";
import { ai, CHAT_FEATURE, RAG_DATABASE_URL, VISITOR } from "./aiguard.js";
import { count, createPool, type Pool } from "./store.js";
import { retrieve } from "./retrieve.js";

const PORT = Number(process.env.PORT ?? 3005);
const publicFile = (name: string): string => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

let pool: Pool | null = null;
let kbCount = 0;

function cors(res: ServerResponse): void {
  // The widget is embedded on other sites, so allow cross-origin POSTs to /api.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function serveStatic(res: ServerResponse, name: string, type: string): Promise<void> {
  try {
    const body = await readFile(publicFile(name));
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/**
 * The core flow: retrieve KB context (pgvector) for the question, then ask the
 * grounded `support_chat` feature to answer ONLY from that context. The gateway
 * masks PII in the question, verifies the answer's citations, and returns a
 * refusal for anything it can't verify.
 */
async function handleChat(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  if (!pool) {
    return sendJson(res, 503, { error: "knowledge base unavailable (no database connection)" });
  }
  // kbCount is cached from boot; if it's 0, re-check once so ingesting AFTER the
  // server started (or re-ingesting) doesn't wedge the endpoint at 503 forever.
  if (kbCount === 0) {
    try {
      kbCount = await count(pool);
    } catch {
      /* fall through to the 503 below */
    }
    if (kbCount === 0) {
      return sendJson(res, 503, {
        error: "knowledge base is empty — run `pnpm ingest` first (writes to pgvector)",
      });
    }
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "web-visitor";
  if (!message) return sendJson(res, 400, { error: "message is required" });

  try {
    const { chunks, receipt: embedReceipt } = await retrieve(pool, message, sessionId, 4);
    const answer = await ai.chat({
      userId: sessionId,
      userType: VISITOR,
      feature: CHAT_FEATURE,
      context: chunks.map((c) => c.text),
      messages: [{ role: "user", content: message }],
      temperature: 0,
    });
    sendJson(res, 200, {
      answer: answer.message.content,
      grounded: answer.safety.grounded ?? null,
      piiMasked: answer.safety.piiMasked,
      sources: chunks.map((c) => ({ source: c.source, score: Number(c.score.toFixed(3)) })),
      receipt: {
        embed: embedReceipt,
        chat: {
          model: answer.model,
          provider: answer.provider,
          decision: answer.decision,
          costUsd: answer.cost.actualUsd,
          requestId: answer.requestId,
          dailyUsdRemaining: answer.budgetRemaining?.userDailyUsd ?? null,
        },
      },
    });
  } catch (err) {
    if (err instanceof AiGuardError) {
      return sendJson(res, 200, {
        blocked: true,
        code: err.code,
        answer:
          err.code === "budget_exceeded"
            ? "You've reached today's usage limit for this assistant. Please try again tomorrow or contact support."
            : "I can't answer that right now.",
        detail: err.body,
      });
    }
    console.error("chat error", err);
    sendJson(res, 502, { error: "assistant temporarily unavailable" });
  }
}

const server = createServer((req, res) => {
  cors(res);
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/demo.html")) {
    return void serveStatic(res, "demo.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/widget.js") {
    return void serveStatic(res, "widget.js", "application/javascript; charset=utf-8");
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    return void readJson(req)
      .then((body) => handleChat(res, body))
      .catch(() => sendJson(res, 400, { error: "invalid JSON body" }));
  }
  res.writeHead(404).end("not found");
});

async function main(): Promise<void> {
  pool = createPool(RAG_DATABASE_URL);
  try {
    kbCount = await count(pool);
    console.log(`Loaded ${kbCount} KB vectors from pgvector (kb_chunks).`);
  } catch {
    console.warn(`⚠  Could not read kb_chunks. Run \`pnpm ingest\` first; /api/chat will 503 until then.`);
  }
  server.listen(PORT, () => {
    console.log(`\nRAG support demo → http://localhost:${PORT}`);
    console.log(`Embed the widget anywhere with:`);
    console.log(`  <script src="http://localhost:${PORT}/widget.js" data-endpoint="http://localhost:${PORT}/api/chat"></script>\n`);
  });
}

void main();
