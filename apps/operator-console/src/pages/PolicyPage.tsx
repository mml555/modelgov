import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

interface PolicyVersion {
  id: string;
  createdAt: string;
  activatedAt?: string;
  note?: string;
}

export function PolicyPage() {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [active, setActive] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch<{ items: PolicyVersion[] }>("/v1/admin/policy/versions").catch(() => ({ items: [] })),
      apiFetch<Record<string, unknown>>("/v1/admin/policy/active").catch(() => null),
    ]).then(([v, a]) => {
      setVersions(v.items);
      setActive(a);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1>Policy versions</h1>
      <p>Requires <code>policy:read</code>. Edit/activate via API or CLI.</p>
      {error && <p className="error">{error}</p>}
      {active && (
        <div className="card">
          <h2>Active</h2>
          <pre className="mono">{JSON.stringify(active, null, 2)}</pre>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>ID</th><th>Created</th><th>Activated</th><th>Note</th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.id}</td>
                <td>{new Date(v.createdAt).toLocaleString()}</td>
                <td>{v.activatedAt ? new Date(v.activatedAt).toLocaleString() : "—"}</td>
                <td>{v.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
