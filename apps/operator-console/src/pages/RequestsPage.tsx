import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

// Matches requestRecordJsonSchema from GET /v1/requests.
interface RequestRow {
  id: string;
  userId?: string;
  feature: string;
  status: string;
  reasonCode?: string;
  timestamps: { createdAt: string };
  actualCostUsd?: number;
}

export function RequestsPage() {
  const [items, setItems] = useState<RequestRow[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const q = status ? `?limit=50&status=${status}` : "?limit=50";
    apiFetch<{ items: RequestRow[] }>(`/v1/requests${q}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [status]);

  return (
    <div>
      <h1>Request logs</h1>
      <p>Metadata only — no message content.</p>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginBottom: "1rem" }}>
        <option value="">All statuses</option>
        <option value="completed">completed</option>
        <option value="blocked">blocked</option>
        <option value="safety_blocked">safety_blocked</option>
        <option value="error">error</option>
      </select>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>User</th><th>Feature</th><th>Status</th><th>Reason</th><th>Cost</th><th>Time</th>
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
