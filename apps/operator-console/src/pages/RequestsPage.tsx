import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

// Matches requestRecordJsonSchema from GET /v1/requests.
interface RequestRow {
  id: string;
  userId?: string;
  feature: string;
  status: string;
  reasonCode?: string;
  correlationId?: string;
  timestamps: { createdAt: string };
  actualCostUsd?: number;
}

export function RequestsPage() {
  const [items, setItems] = useState<RequestRow[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Filter to a single transaction (the reused x-request-id). Debounced-applied
  // via the committed `correlationId` state below.
  const [correlationInput, setCorrelationInput] = useState("");
  const [correlationId, setCorrelationId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (status) params.set("status", status);
    if (correlationId) params.set("correlationId", correlationId);
    apiFetch<{ items: RequestRow[] }>(`/v1/requests?${params.toString()}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [status, correlationId]);

  return (
    <div>
      <h1>Request logs</h1>
      <p>Metadata only — no message content.</p>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="completed">completed</option>
          <option value="blocked">blocked</option>
          <option value="safety_blocked">safety_blocked</option>
          <option value="error">error</option>
        </select>
        <input
          type="text"
          placeholder="Transaction (correlation id)"
          value={correlationInput}
          onChange={(e) => setCorrelationInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setCorrelationId(correlationInput.trim());
          }}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={() => setCorrelationId(correlationInput.trim())}>
          Filter
        </button>
        {correlationId && (
          <button
            type="button"
            onClick={() => {
              setCorrelationInput("");
              setCorrelationId("");
            }}
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>User</th><th>Feature</th><th>Status</th><th>Reason</th><th>Transaction</th><th>Cost</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>{r.userId ?? "—"}</td>
                <td>{r.feature}</td>
                <td>{r.status}</td>
                <td>{r.reasonCode ?? "—"}</td>
                <td className="mono">{r.correlationId ?? "—"}</td>
                <td>{r.actualCostUsd?.toFixed(4) ?? "—"}</td>
                <td>{new Date(r.timestamps.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
