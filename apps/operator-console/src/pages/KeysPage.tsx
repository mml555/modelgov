import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

// Matches keyRecordJsonSchema from GET /v1/admin/keys.
interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  revokedAt?: string;
}

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [error, setError] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [name, setName] = useState("");

  function reload() {
    apiFetch<{ items: KeyRow[] }>("/v1/admin/keys")
      .then((r) => setKeys(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => { reload(); }, []);

  async function createKey() {
    setError("");
    setCreatedSecret(null);
    try {
      const res = await apiFetch<{ secret: string }>("/v1/admin/keys", {
        method: "POST",
        body: JSON.stringify({ name: name || "console-created", permissions: ["chat:create"] }),
      });
      setCreatedSecret(res.secret);
      setName("");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function revoke(id: string) {
    await apiFetch(`/v1/admin/keys/${id}/revoke`, { method: "POST" });
    reload();
  }

  return (
    <div>
      <h1>API keys</h1>
      <p>Requires <code>keys:admin</code>. Secrets shown once at creation only.</p>
      {error && <p className="error">{error}</p>}
      {createdSecret && (
        <div className="card status-warn">
          <strong>Copy now — this secret will not be shown again:</strong>
          <pre className="mono">{createdSecret}</pre>
        </div>
      )}
      <div className="card">
        <input placeholder="Key name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={createKey}>Create key</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Prefix</th><th>Permissions</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="mono">{k.keyPrefix}</td>
                <td>{k.permissions.join(", ")}</td>
                <td>{k.revokedAt ? "revoked" : "active"}</td>
                <td>{!k.revokedAt && <button type="button" className="secondary" onClick={() => revoke(k.id)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
