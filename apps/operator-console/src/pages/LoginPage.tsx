import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiBase, setBase, setToken } from "../api/client";

export function LoginPage() {
  const nav = useNavigate();
  const [url, setUrl] = useState(apiBase());
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/v1/usage/summary?since=24h`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        setError("Invalid API key or insufficient permissions (need usage:read or owner)");
        return;
      }
      if (!res.ok) {
        setError(`API returned ${res.status}`);
        return;
      }
      setBase(url);
      setToken(token);
      nav("/overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  }

  return (
    <div className="login-page">
      <form className="login-box card" onSubmit={onSubmit}>
        <h1>Operator login</h1>
        <p>Use an API key or OIDC JWT with operator permissions.</p>
        <label>API URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:3000" />
        <label>Bearer token</label>
        <input type="password" value={token} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" />
        {error && <p className="error">{error}</p>}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
