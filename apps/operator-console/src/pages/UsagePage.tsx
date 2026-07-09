import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { fetchTransactions, type Transaction } from "../api/usage";

export function UsagePage() {
  const [summary, setSummary] = useState<unknown>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState("");
  const [txnError, setTxnError] = useState("");

  useEffect(() => {
    apiFetch("/v1/usage/summary?since=30d")
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetchTransactions("30d")
      .then((r) => setTransactions(r.transactions))
      .catch((e) => setTxnError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1>Usage & spend</h1>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <pre className="mono">{JSON.stringify(summary, null, 2)}</pre>
      </div>

      <h2>Cost by transaction</h2>
      <p>Per-transaction rollup (grouped by correlation id), top 50 by cost over 30d. Combines LLM and externally-ingested (non-LLM) cost.</p>
      {txnError && <p className="error">{txnError}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Calls</th>
              <th>LLM $</th>
              <th>External $</th>
              <th>Total $</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.correlationId}>
                <td className="mono">{t.correlationId}</td>
                <td>
                  {t.requests}
                  {t.externalEvents > 0 ? ` (+${t.externalEvents} ext)` : ""}
                </td>
                <td>{t.llmCostUsd.toFixed(4)}</td>
                <td>{t.externalCostUsd > 0 ? t.externalCostUsd.toFixed(4) : "—"}</td>
                <td>{t.actualCostUsd.toFixed(4)}</td>
                <td>{new Date(t.lastSeen).toLocaleString()}</td>
              </tr>
            ))}
            {transactions.length === 0 && !txnError && (
              <tr>
                <td colSpan={6}>No transactions in this window.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
