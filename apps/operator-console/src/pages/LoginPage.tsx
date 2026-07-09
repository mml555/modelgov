import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiBase, setBase, setToken } from "../api/client";
import { isInsecureRemoteUrl } from "../api/insecureRemote";

function isLocalDevGateway(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function probeLogin(url: string, token: string): Promise<string | null> {
  // Time-box the probe so a hung gateway doesn't leave the user stuck on the
  // "Opening your local console…" screen indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}/v1/usage/summary?since=24h`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return "The gateway didn't respond in time. Is the stack running? Try: make status";
    }
    return `Could not reach the API. Is the stack running? Try: make status`;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    return "Could not connect. Run ./setup again and click the link it prints.";
  }
  if (!res.ok) {
    return `Could not reach the API (HTTP ${res.status}). Is the stack running? Try: make status`;
  }
  return null;
}

export function LoginPage() {
  const nav = useNavigate();
  const [url, setUrl] = useState(apiBase());
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  // ./setup prints a console link with ?url=&token= — connect automatically.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autoUrl = params.get("url");
    const autoToken = params.get("token");
    if (!autoUrl || !autoToken) return;

    // Local first-run: ./setup already created keys and smoke-tested the API.
    // Trust the printed link — no OpenAI key or manual config required.
    if (isLocalDevGateway(autoUrl)) {
      setConnecting(true);
      setBase(autoUrl);
      setToken(autoToken);
      nav("/setup", { replace: true });
      return;
    }

    let cancelled = false;
    setConnecting(true);
    setUrl(autoUrl);
    setTokenInput(autoToken);

    void (async () => {
      try {
        const loginError = await probeLogin(autoUrl, autoToken);
        if (cancelled) return;
        if (loginError) {
          setError(loginError);
          setConnecting(false);
          return;
        }
        setBase(autoUrl);
        setToken(autoToken);
        nav("/overview", { replace: true });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `${err.message} — is the API running? Try: make status`
            : "Connection failed — is the API running? Try: make status",
        );
        setConnecting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nav]);

  const insecureRemote = isInsecureRemoteUrl(url);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const loginError = await probeLogin(url, token);
      if (loginError) {
        setError(loginError);
        return;
      }
      setBase(url);
      setToken(token);
      nav("/overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  }

  if (connecting) {
    return (
      <div className="login-page">
        <div className="login-box card">
          <h1>Modelgov Console</h1>
          <p>Opening your local console…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-box card" onSubmit={onSubmit}>
        <h1>Modelgov Console</h1>
        <p className="hint">
          First time here? Run <code>./setup</code> in the project folder, then click the link it
          prints. That starts everything with a built-in demo — no OpenAI key or account needed.
        </p>
        <label>Gateway URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3090" />
        {insecureRemote && (
          <p className="error">
            This URL uses plain http to a remote host — credentials will be sent unencrypted. Use https.
          </p>
        )}
        <label>Local access key (only if not using the ./setup link)</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="sk-modelgov-api-local"
          autoComplete="off"
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">Open console</button>
      </form>
    </div>
  );
}
