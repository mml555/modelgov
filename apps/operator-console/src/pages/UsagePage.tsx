import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

export function UsagePage() {
  const [summary, setSummary] = useState<unknown>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/v1/usage/summary?since=30d")
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1>Usage & spend</h1>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <pre className="mono">{JSON.stringify(summary, null, 2)}</pre>
      </div>
    </div>
  );
}
