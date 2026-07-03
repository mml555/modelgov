"use client";

import { useRef, useState } from "react";

type Decision = "allow" | "degrade" | "fallback";
interface Meta {
  model: string;
  provider: string;
  decision: Decision;
  reason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: {
    userDailyUsd: number;
    userDailyTokens?: number | null;
  };
  safety: { piiMasked: boolean; injectionBlocked: boolean };
  requestId: string;
}
type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; meta: Meta }
  | { role: "system"; content: string; tone: "block" | "error"; reasonCode?: string };

const TIERS = [
  { value: "anonymous", label: "anonymous (free — tiny caps)" },
  { value: "logged_in", label: "logged_in (standard)" },
  { value: "admin", label: "admin (premium)" },
];
const FEATURES = [
  { value: "support_chat", label: "support_chat" },
  { value: "notes_helper", label: "notes_helper" },
];

const usd = (n: number) => `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;

// Strip the provider prefix from a model string for compact display.
const modelName = (provider: string, model: string) =>
  model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;

const PROVIDER_COLOR: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  gemini: "#4285f4",
  openrouter: "#8b5cf6",
  azure: "#0078d4",
  ollama: "#8a8f98",
};

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [tier, setTier] = useState("anonymous");
  const [feature, setFeature] = useState("support_chat");
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<Meta["budgetRemaining"] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const scroll = () => requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const nextUser: Msg = { role: "user", content: text };
    const history = [...messages, nextUser];
    setMessages(history);
    setInput("");
    setBusy(true);
    scroll();

    // Send the running conversation (text only) + the chosen tier/feature.
    const convo = history
      .filter((m): m is Extract<Msg, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: convo, userType: tier, feature }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessages((m) => [...m, { role: "assistant", content: data.reply, meta: data.meta as Meta }]);
        setBudget((data.meta as Meta).budgetRemaining);
      } else {
        if (data.budgetRemaining) setBudget(data.budgetRemaining);
        setMessages((m) => [
          ...m,
          { role: "system", tone: data.kind === "error" || data.kind === "unavailable" ? "error" : "block", content: data.message ?? "Blocked.", reasonCode: data.reasonCode },
        ]);
      }
    } catch {
      setMessages((m) => [...m, { role: "system", tone: "error", content: "Network error reaching the gateway." }]);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  return (
    <div className="wrap">
      <h1 style={{ marginBottom: 4 }}>Modelgov Chatbot</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Every message is checked by Modelgov <b>before</b> the model runs — budget, tokens, model access, and safety.
        Each reply shows what Modelgov decided.
      </p>

      <div className="card" style={{ padding: 12, display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <label>Tier&nbsp;
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label>Feature&nbsp;
          <select value={feature} onChange={(e) => setFeature(e.target.value)}>
            {FEATURES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {budget && (
          <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
            remaining today: <b>{usd(budget.userDailyUsd)}</b>
            {typeof budget.userDailyTokens === "number" ? <> · <b>{budget.userDailyTokens}</b> tokens</> : null}
          </span>
        )}
      </div>

      <div ref={listRef} className="card" style={{ height: 460, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <p className="muted" style={{ margin: "auto", textAlign: "center" }}>
            Try chatting as <b>anonymous</b> and watch it hit the daily cap — then switch to <b>logged_in</b>.
          </p>
        )}
        {messages.map((m, i) => <Bubble key={i} msg={m} />)}
        {busy && <div className="muted">…thinking</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #2c3860", background: "#0e1526", color: "#e6e8ef" }}
          placeholder="Ask something…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button
          style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#3b6bff", color: "white", fontWeight: 600 }}
          onClick={send}
          disabled={busy}
        >Send</button>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  if (msg.role === "system") {
    return (
      <div style={{ alignSelf: "center", maxWidth: "90%", textAlign: "center" }}>
        <span className={`badge block`}>{msg.tone === "block" ? "⛔ blocked" : "⚠️ error"}{msg.reasonCode ? ` · ${msg.reasonCode}` : ""}</span>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{msg.content}</div>
      </div>
    );
  }
  const mine = msg.role === "user";
  return (
    <div style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "80%" }}>
      <div style={{ padding: "9px 12px", borderRadius: 10, background: mine ? "#20314f" : "#0e1526", border: "1px solid #26304d", whiteSpace: "pre-wrap" }}>
        {msg.content}
      </div>
      {!mine && "meta" in msg && <Receipt meta={msg.meta} />}
    </div>
  );
}

function Receipt({ meta }: { meta: Meta }) {
  const provider = meta.provider; // first-class field from the API — no parsing
  const name = modelName(provider, meta.model);
  const color = PROVIDER_COLOR[provider] ?? "#8a8f98";
  return (
    <div style={{ marginTop: 5, fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <span className={`badge ${meta.decision}`}>{meta.decision}</span>
      <span
        className="badge"
        title={`provider: ${provider}`}
        style={{ color, borderColor: color, textTransform: "lowercase" }}
      >
        {provider}
      </span>
      <span className="muted">{name}</span>
      <span className="muted">· {meta.usage.inputTokens ?? "?"}→{meta.usage.outputTokens ?? "?"} tok</span>
      <span className="muted">· {usd(meta.cost.actualUsd)}</span>
      {meta.safety.piiMasked && <span className="badge">PII masked</span>}
      <span className="muted" title="Modelgov audit id">· {meta.requestId}</span>
    </div>
  );
}
