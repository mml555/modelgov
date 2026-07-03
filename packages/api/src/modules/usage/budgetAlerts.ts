import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { monthWindowStart } from "../../services/windows";
import { claimGlobalMonthlyBudgetAlert } from "./budgetAlertRepo";
import { enqueueWebhook } from "../../services/webhookOutbox";

export interface BudgetAlertPayload {
  globalSpendUsd: number;
  alertThresholdUsd: number;
  alertAtPercent: number;
  monthlyCapUsd: number;
  now?: Date;
}

export interface BudgetAlertWebhookConfig {
  url: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Log + optionally POST a webhook when global spend crosses alert_at_percent.
 * Webhook fires at most once per calendar month (atomic claim in Postgres).
 */
export async function handleGlobalBudgetAlert(
  pool: Pool,
  webhook: BudgetAlertWebhookConfig | undefined,
  payload: BudgetAlertPayload,
  log?: {
    warn(obj: unknown, msg: string): void;
    error?(obj: unknown, msg: string): void;
  },
): Promise<void> {
  const now = payload.now ?? new Date();
  const windowStart = monthWindowStart(now).slice(0, 10);
  const firstThisMonth = await claimGlobalMonthlyBudgetAlert(pool, windowStart);

  if (firstThisMonth) {
    log?.warn(
      {
        globalSpendUsd: payload.globalSpendUsd,
        alertThresholdUsd: payload.alertThresholdUsd,
        alertAtPercent: payload.alertAtPercent,
        monthlyCapUsd: payload.monthlyCapUsd,
      },
      "global budget alert threshold reached",
    );
  }

  if (!webhook || !firstThisMonth) return;

  const body = {
    event: "budget.alert",
    scope: "global_monthly",
    windowStart,
    globalSpendUsd: payload.globalSpendUsd,
    alertThresholdUsd: payload.alertThresholdUsd,
    alertAtPercent: payload.alertAtPercent,
    monthlyCapUsd: payload.monthlyCapUsd,
    sentAt: now.toISOString(),
  };

  try {
    await enqueueWebhook(pool, {
      eventType: "budget.alert",
      payload: body,
      destinationUrl: webhook.url,
      secret: webhook.secret,
    });
  } catch (err) {
    log?.error?.({ err, url: webhook.url }, "budget alert outbox enqueue failed");
    void deliverWebhook(webhook, body, log);
  }
}

async function deliverWebhook(
  webhook: BudgetAlertWebhookConfig,
  body: Record<string, unknown>,
  log?: {
    warn(obj: unknown, msg: string): void;
    error?(obj: unknown, msg: string): void;
  },
): Promise<void> {
  const doFetch = webhook.fetchImpl ?? fetch;
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "modelgov/0.1",
  };
  if (webhook.secret) {
    const digest = createHmac("sha256", webhook.secret).update(json).digest("hex");
    headers["x-modelgov-signature"] = `sha256=${digest}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    webhook.timeoutMs ?? 10_000,
  );
  try {
    const res = await doFetch(webhook.url, {
      method: "POST",
      headers,
      body: json,
      signal: controller.signal,
    });
    if (!res.ok) {
      log?.error?.(
        { status: res.status, url: webhook.url },
        "budget alert webhook returned non-2xx",
      );
    }
  } catch (err) {
    log?.error?.({ err, url: webhook.url }, "budget alert webhook delivery failed");
  } finally {
    clearTimeout(timer);
  }
}
