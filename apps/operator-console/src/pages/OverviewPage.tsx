import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

// Matches UsageSummaryReport from GET /v1/usage/summary.
interface Summary {
  since: string;
  requests: number;
  completed: number;
  blocked: number;
  degraded: number;
  fallbacks: number;
  safetyBlocked: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  topReasonCode?: { code: string; count: number };
  topModel?: { model: string; count: number };
}

export function OverviewPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<Summary>("/v1/usage/summary?since=7d")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1>Overview</h1>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="card">
            <p>Last 7 days (tenant-scoped to your key)</p>
            <p>Requests: <strong>{data.requests}</strong></p>
            <p>Actual cost (USD): <strong>{data.actualCostUsd.toFixed(4)}</strong></p>
            <p>Estimated cost (USD): <strong>{data.estimatedCostUsd.toFixed(4)}</strong></p>
          </div>
          <div className="card">
            <h2>Outcomes</h2>
            <table>
              <thead><tr><th>Outcome</th><th>Count</th></tr></thead>
              <tbody>
                <tr><td>Completed</td><td>{data.completed}</td></tr>
                <tr><td>Budget/policy blocked</td><td>{data.blocked}</td></tr>
                <tr><td>Safety blocked</td><td>{data.safetyBlocked}</td></tr>
                <tr><td>Degraded</td><td>{data.degraded}</td></tr>
                <tr><td>Provider fallbacks</td><td>{data.fallbacks}</td></tr>
              </tbody>
            </table>
          </div>
          {(data.topReasonCode || data.topModel) && (
            <div className="card">
              <h2>Top</h2>
              {data.topReasonCode && (
                <p>Reason code: <strong>{data.topReasonCode.code}</strong> ({data.topReasonCode.count})</p>
              )}
              {data.topModel && (
                <p>Model: <strong>{data.topModel.model}</strong> ({data.topModel.count})</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
