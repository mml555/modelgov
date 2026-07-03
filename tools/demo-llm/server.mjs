import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function tokenEstimate(messages) {
  const text = messages
    .map((message) => String(message?.content ?? ""))
    .join(" ");
  return Math.max(8, Math.ceil(text.length / 4));
}

function completionFor(messages) {
  const systemText = messages
    .filter((message) => message?.role === "system")
    .map((message) => String(message?.content ?? ""))
    .join("\n");
  if (systemText.includes("Reply with exactly one word: INJECTION")) {
    return "SAFE";
  }
  return "Hello from the local Modelgov demo provider. Your one-command setup is working.";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/models")) {
      if (url.pathname === "/health") {
        json(res, 200, { status: "ok", service: "modelgov-demo-llm" });
        return;
      }
      json(res, 200, {
        object: "list",
        data: [{ id: "modelgov-demo", object: "model", owned_by: "modelgov" }],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const promptTokens = tokenEstimate(messages);
      const completion = completionFor(messages);
      const completionTokens = tokenEstimate([{ content: completion }]);
      json(res, 200, {
        id: `chatcmpl-demo-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: String(body.model ?? "modelgov-demo"),
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: completion },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
      return;
    }

    json(res, 404, { error: { message: "not found" } });
  } catch (err) {
    json(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`demo llm listening on ${port}`);
});
