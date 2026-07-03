import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import { checkUserIdAllowed, checkUserTypeAllowedIfPresent } from "../authz/scope";
import { isPrivateHttpHost } from "../../util/httpUrlGuard";
import type { BillingService } from "./service";

const topUpBodySchema = z.object({
  userId: z.string().min(1),
  creditsUsd: z.number().positive(),
  stripeCustomerId: z.string().optional(),
  userType: z.string().optional(),
});

export function registerBillingRoutes(
  app: FastifyInstance,
  pool: Pool,
  billing: BillingService | undefined,
): void {
  app.get("/v1/users/:userId/balance", {
    schema: {
      tags: ["billing"],
      description: "Credit wallet balance for a user (when billing integration is enabled).",
      params: {
        type: "object",
        required: ["userId"],
        properties: { userId: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    if (!billing?.enabled) {
      return sendError(reply, 501, "not_implemented", {}, "Billing integration is not enabled");
    }
    if (!request.ctx.permissions?.includes("usage:read")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to read balances");
    }
    const userId = (request.params as { userId: string }).userId;
    // Same user-scope enforcement as /v1/usage: a key restricted with
    // allowedUserIds must not read another user's wallet within the tenant.
    const denial = checkUserIdAllowed(request.ctx, userId);
    if (denial) return sendError(reply, denial.status, denial.code, {}, denial.message);
    const balance = await billing.getBalance(request.ctx.tenantId ?? "", userId);
    return reply.send(balance);
  });

  app.post("/v1/admin/billing/top-up", {
    schema: {
      tags: ["admin", "billing"],
      description: "Add credits to a user wallet. Requires billing:write.",
    },
  }, async (request, reply) => {
    if (!billing?.enabled) {
      return sendError(reply, 501, "not_implemented", {}, "Billing integration is not enabled");
    }
    if (!request.ctx.permissions?.includes("billing:write")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to manage billing");
    }
    const parsed = topUpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    // Same user/userType scope enforcement as the balance read: a billing:write
    // key restricted with allowedUserIds/allowedUserTypes must not mint credits
    // for arbitrary users in the tenant (the write path is more dangerous than
    // the read, so it must be at least as tightly scoped).
    const userDenial = checkUserIdAllowed(request.ctx, parsed.data.userId);
    if (userDenial) return sendError(reply, userDenial.status, userDenial.code, {}, userDenial.message);
    const typeDenial = checkUserTypeAllowedIfPresent(request.ctx, parsed.data.userType);
    if (typeDenial) return sendError(reply, typeDenial.status, typeDenial.code, {}, typeDenial.message);
    await billing.adminTopUp({
      tenantId: request.ctx.tenantId ?? "",
      ...parsed.data,
    });
    const balance = await billing.getBalance(request.ctx.tenantId ?? "", parsed.data.userId);
    return reply.send({ ok: true, balance });
  });

  if (billing?.enabled) {
    app.register(async (scope) => {
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (req, body, done) => {
          (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
          try {
            done(null, JSON.parse((body as Buffer).toString("utf8")));
          } catch (err) {
            done(err as Error, undefined);
          }
        },
      );

      scope.post("/v1/webhooks/stripe", {
        schema: {
          tags: ["billing"],
          description: "Stripe webhook receiver (signature-verified).",
        },
      }, async (request: FastifyRequest & { rawBody?: Buffer }, reply) => {
        const signature = request.headers["stripe-signature"];
        const raw =
          request.rawBody ??
          Buffer.from(JSON.stringify(request.body ?? {}));
        try {
          await billing.handleStripeWebhook(
            raw,
            typeof signature === "string" ? signature : undefined,
            request.log,
          );
          return reply.send({ received: true });
        } catch (err) {
          request.log.warn({ err }, "stripe webhook rejected");
          return sendError(
            reply,
            400,
            "webhook_invalid",
            {},
            err instanceof Error ? err.message : "Invalid webhook",
          );
        }
      });
    });
  }
}

export async function deliverOutboxWebhook(
  entry: {
    id: number;
    payload: Record<string, unknown>;
    destinationUrl: string;
    secret?: string;
    attempts: number;
  },
  fetchImpl: typeof fetch = fetch,
  opts: { allowPrivateHosts?: boolean } = {},
): Promise<void> {
  // Re-apply the SSRF host guard at the delivery sink. The only enqueue path
  // today (budget alerts) validates the URL at boot, but the sink must not trust
  // that: a future enqueue path, a tampered row, or a config change could put a
  // private/link-local destination in the outbox. Throwing here marks the row
  // failed (retried, then dead-lettered) instead of POSTing to an internal host.
  // allowPrivateHosts mirrors BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE so an operator
  // who deliberately points alerts at a private host is not blocked.
  let target: URL;
  try {
    target = new URL(entry.destinationUrl);
  } catch {
    throw new Error(`invalid outbox destination URL: ${entry.destinationUrl}`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`outbox destination URL must be http(s): ${entry.destinationUrl}`);
  }
  if (!opts.allowPrivateHosts && isPrivateHttpHost(target.hostname)) {
    throw new Error(
      `refusing to deliver webhook to private/link-local host '${target.hostname.toLowerCase()}' (SSRF guard)`,
    );
  }

  const json = JSON.stringify(entry.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "modelgov/1.0",
  };
  if (entry.secret) {
    const digest = createHmac("sha256", entry.secret).update(json).digest("hex");
    headers["x-modelgov-signature"] = `sha256=${digest}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(entry.destinationUrl, {
      method: "POST",
      headers,
      body: json,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
