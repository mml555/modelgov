// Build-time default; overridable at login and persisted, so one static build
// serves any deployment (no rebuild per API URL — important for the nginx image).
const DEFAULT_BASE = import.meta.env.VITE_AI_GUARD_URL ?? "http://127.0.0.1:3000";
const TOKEN_KEY = "ai-guard-console-token";
const BASE_KEY = "ai-guard-console-url";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Persist the operator-chosen API base URL so apiFetch actually targets it. */
export function setBase(url: string): void {
  sessionStorage.setItem(BASE_KEY, url.replace(/\/$/, ""));
}

export function apiBase(): string {
  return (sessionStorage.getItem(BASE_KEY) ?? DEFAULT_BASE).replace(/\/$/, "");
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
