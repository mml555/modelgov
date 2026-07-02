export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const message =
        typeof body === "object" && body && "error" in body && body.error?.message
          ? body.error.message
          : `request failed (${res.status})`;
      throw new Error(message);
    }
    return body as T;
  }

  async postJson<T>(path: string, payload?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const message =
        typeof body === "object" && body && "error" in body && body.error?.message
          ? body.error.message
          : `request failed (${res.status})`;
      throw new Error(message);
    }
    return body as T;
  }
}

export function clientFromEnv(): ApiClient {
  const apiKey = process.env.AI_GUARD_API_KEY;
  if (!apiKey) {
    throw new Error("AI_GUARD_API_KEY is required");
  }
  return new ApiClient({
    baseUrl: process.env.AI_GUARD_URL ?? "http://localhost:3000",
    apiKey,
  });
}
