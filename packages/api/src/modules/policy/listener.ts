import { Client } from "pg";
import type { ClientConfig } from "pg";

/**
 * Postgres channel a replica NOTIFYs on when it activates a policy version. The
 * payload is the affected tenantId. Every replica LISTENs and invalidates that
 * tenant's cached policy immediately, so a newly-activated version applies
 * without a restart — the per-tenant TTL cache is only the backstop for a missed
 * notification (a brief connection gap during a failover).
 */
export const POLICY_ACTIVATED_CHANNEL = "modelgov_policy_activated";

/** Minimal surface of a pg Client we depend on — lets tests inject a fake. */
export interface ListenClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  removeAllListeners(): void;
  end(): Promise<void>;
}

export interface PolicyActivationListener {
  stop(): Promise<void>;
}

interface Logger {
  info(msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export interface StartListenerOptions {
  /** Connection config for the dedicated LISTEN client (same DB as the pool). */
  clientConfig?: ClientConfig;
  /** Called with the tenantId from each activation notification. */
  onActivated: (tenantId: string) => void;
  log?: Logger;
  /** Injectable client factory (tests supply a fake; default builds a pg Client). */
  createClient?: () => ListenClient;
  /** Reconnect backoff: base doubles each failure up to max. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable timer (tests). */
  scheduleReconnect?: (fn: () => void, ms: number) => { cancel: () => void };
}

/**
 * Start listening for policy-activation notifications. Resilient by design: a
 * connection error or drop schedules a capped exponential-backoff reconnect
 * rather than throwing, so a listener hiccup degrades to TTL-bounded convergence
 * instead of failing boot or a request. `stop()` is idempotent and cancels any
 * pending reconnect.
 */
export function startPolicyActivationListener(opts: StartListenerOptions): PolicyActivationListener {
  const log = opts.log;
  const baseMs = opts.reconnectBaseMs ?? 500;
  const maxMs = opts.reconnectMaxMs ?? 30_000;
  const makeClient = opts.createClient ?? (() => new Client(opts.clientConfig) as unknown as ListenClient);
  const schedule =
    opts.scheduleReconnect ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // Don't keep the event loop alive solely for the reconnect timer.
      if (typeof t.unref === "function") t.unref();
      return { cancel: () => clearTimeout(t) };
    });

  let stopped = false;
  let client: ListenClient | null = null;
  let pending: { cancel: () => void } | null = null;
  let attempt = 0;

  function scheduleReconnect(): void {
    if (stopped || pending) return;
    // Full-jitter would need a clock; a plain capped exponential is enough here.
    const delay = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    pending = schedule(() => {
      pending = null;
      void connect();
    }, delay);
  }

  // Tear down a SPECIFIC client. Only clears the shared `client` ref when it
  // still points at the one being torn down — otherwise a stale callback (e.g.
  // the original connect's rejection firing after a reconnect already installed
  // a fresh client) would tear down the healthy replacement mid-connect.
  async function teardownClient(target: ListenClient): Promise<void> {
    if (client === target) client = null;
    target.removeAllListeners();
    await target.end().catch(() => {});
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    let c: ListenClient;
    try {
      c = makeClient();
    } catch (err) {
      log?.warn({ err }, "policy activation listener: failed to create client");
      scheduleReconnect();
      return;
    }
    client = c;
    // A drop (error/end) after a successful LISTEN must reconnect, or this
    // replica would silently stop hot-reloading and rely only on the TTL. The
    // `client !== c` guard makes stale handlers for a replaced client no-ops.
    c.on("error", (err) => {
      if (client !== c) return;
      log?.warn({ err }, "policy activation listener error — reconnecting");
      void teardownClient(c).then(scheduleReconnect);
    });
    c.on("end", () => {
      if (stopped || client !== c) return;
      void teardownClient(c).then(scheduleReconnect);
    });
    c.on("notification", (msg) => {
      if (msg.channel !== POLICY_ACTIVATED_CHANNEL) return;
      const tenantId = msg.payload;
      if (tenantId) opts.onActivated(tenantId);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${POLICY_ACTIVATED_CHANNEL}`);
      attempt = 0; // reset backoff on a clean connect
      log?.info("policy activation listener connected");
    } catch (err) {
      if (stopped) return;
      // Only reconnect if this attempt owned the active client — a stale rejection
      // for a client already replaced by a reconnect must not spawn another loop.
      const wasActive = client === c;
      await teardownClient(c);
      if (wasActive) {
        log?.warn({ err }, "policy activation listener: connect failed — retrying");
        scheduleReconnect();
      }
    }
  }

  void connect();

  return {
    async stop(): Promise<void> {
      stopped = true;
      pending?.cancel();
      pending = null;
      if (client) await teardownClient(client);
    },
  };
}
