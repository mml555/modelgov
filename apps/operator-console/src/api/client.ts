// Build-time default; overridable at login and persisted, so one static build
// serves any deployment (no rebuild per API URL — important for the nginx image).
const DEFAULT_BASE = import.meta.env.VITE_MODELGOV_URL ?? "http://127.0.0.1:3090";
const TOKEN_KEY = "modelgov-console-token";
const BASE_KEY = "modelgov-console-url";
const TENANT_KEY = "modelgov-console-tenant";

/** The tenant a platform operator has selected in the switcher ("" = all). */
export function getTenant(): string {
  return sessionStorage.getItem(TENANT_KEY) ?? "";
}

export function setTenant(tenant: string): void {
  if (tenant) sessionStorage.setItem(TENANT_KEY, tenant);
  else sessionStorage.removeItem(TENANT_KEY);
}

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
  // Platform operators scope every call to the selected tenant; the gateway
  // ignores this header for tenant-bound keys, so it's safe to always send.
  const tenant = getTenant();
  if (tenant) headers.set("x-modelgov-tenant", tenant);
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
