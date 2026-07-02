import { useEffect, useState } from "react";
import { apiBase } from "../api/client";

export function HealthPage() {
  const [health, setHealth] = useState<unknown>(null);
  const [ready, setReady] = useState<unknown>(null);

  useEffect(() => {
    fetch(`${apiBase()}/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({ error: true }));
    fetch(`${apiBase()}/ready`).then((r) => r.json()).then(setReady).catch(() => setReady({ error: true }));
  }, []);

  const readyOk = ready && typeof ready === "object" && (ready as { status?: string }).status === "ready";

  return (
    <div>
      <h1>Health & status</h1>
      <div className="card">
        <h2 className="status-ok">Liveness — /health</h2>
        <pre className="mono">{JSON.stringify(health, null, 2)}</pre>
      </div>
      <div className="card">
        <h2 className={readyOk ? "status-ok" : "status-fail"}>Readiness — /ready</h2>
        <pre className="mono">{JSON.stringify(ready, null, 2)}</pre>
      </div>
    </div>
  );
}
