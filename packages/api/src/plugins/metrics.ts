import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export interface MetricsOptions {
  pool: Pool;
  /** Shared registry (so domain metrics land on the same /metrics output). */
  register?: Registry;
}

/**
 * Expose a Prometheus /metrics endpoint with RED metrics (request rate, errors,
 * duration) plus process defaults and pg pool gauges. Uses a fresh Registry per
 * call so multiple buildServer() invocations in one process (tests) don't
 * collide on the global default registry.
 *
 * When METRICS_AUTH_TOKEN is configured, /metrics requires Authorization: Bearer.
 * Otherwise restrict /metrics at the network layer (internal-only scrape).
 */
export function registerMetrics(app: FastifyInstance, opts: MetricsOptions): void {
  const register = opts.register ?? new Registry();
  collectDefaultMetrics({ register });

  const requests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests by method, route, and status code.",
    labelNames: ["method", "route", "status"] as const,
    registers: [register],
  });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds by method, route, and status code.",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [register],
  });

  // Pool saturation gauges — collected lazily on each scrape.
  new Gauge({
    name: "pg_pool_connections_total",
    help: "Total clients in the pg pool.",
    registers: [register],
    collect() {
      this.set(opts.pool.totalCount);
    },
  });
  new Gauge({
    name: "pg_pool_connections_idle",
    help: "Idle clients in the pg pool.",
    registers: [register],
    collect() {
      this.set(opts.pool.idleCount);
    },
  });
  new Gauge({
    name: "pg_pool_clients_waiting",
    help: "Requests waiting for a pg connection.",
    registers: [register],
    collect() {
      this.set(opts.pool.waitingCount);
    },
  });

  app.addHook("onResponse", async (request, reply) => {
    // Use the matched route pattern (not the raw URL) to keep label cardinality
    // bounded; unmatched paths (404s) collapse to "unknown".
    const route = request.routeOptions?.url ?? "unknown";
    if (route === "/metrics") return;
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    requests.inc(labels);
    if (Number.isFinite(reply.elapsedTime)) {
      duration.observe(labels, reply.elapsedTime / 1000);
    }
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", register.contentType);
    return register.metrics();
  });
}
