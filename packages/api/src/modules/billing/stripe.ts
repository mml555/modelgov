import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith("t="));
  // During webhook-secret rotation Stripe signs with BOTH secrets and sends
  // multiple v1 entries — the event is authentic if ANY of them matches, so
  // checking only the first would drop valid events mid-rotation.
  const sigParts = parts.filter((p) => p.startsWith("v1="));
  if (!timestampPart || sigParts.length === 0) return false;

  const timestampRaw = timestampPart.slice(2);
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSec) return false;

  // Sign over the EXACT timestamp bytes Stripe sent, not the Number()-normalized
  // form: Stripe's scheme HMACs the literal `t=` value, so normalizing (e.g.
  // stripping a leading zero or `+`) would hash a different payload than Stripe
  // signed and reject an authentic event.
  const payload = `${timestampRaw}.${rawBody.toString("utf8")}`;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");

  return sigParts.some((part) => {
    try {
      return timingSafeEqual(Buffer.from(digest), Buffer.from(part.slice(3)));
    } catch {
      return false;
    }
  });
}

// Partial views of Stripe payloads — exactly the fields the webhook handler
// reads. Everything is optional: the shapes come off the wire, so the handler
// must tolerate absence rather than trust a cast.
export interface StripeCheckoutSession {
  customer?: string | null;
  metadata?: Record<string, string>;
  amount_total?: number | null;
  /** ISO-4217 currency of amount_total (lowercase, e.g. "usd"). */
  currency?: string | null;
}

export interface StripeSubscription {
  customer?: string | null;
  status?: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
}

/** Outcome of a Stripe meter-event report, distinguishing retryable from permanent. */
export type MeterEventResult =
  | { ok: true; id: string }
  | { ok: false; status?: number; retryable: boolean; error: string };

export interface StripeInvoice {
  customer?: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export async function createStripeMeterEvent(
  secretKey: string,
  params: {
    eventName: string;
    stripeCustomerId: string;
    value: number;
    identifier: string;
    /** Unix seconds the usage occurred; invoices it in the right period. */
    timestamp?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<MeterEventResult> {
  const body = new URLSearchParams({
    event_name: params.eventName,
    "payload[stripe_customer_id]": params.stripeCustomerId,
    "payload[value]": String(params.value),
    identifier: params.identifier,
  });
  // Stamp the event with WHEN the usage happened, not when the flush ran, so a
  // backlog (Stripe outage / flush lag) is invoiced in the correct billing period.
  if (params.timestamp != null && Number.isFinite(params.timestamp)) {
    body.set("timestamp", String(Math.floor(params.timestamp)));
  }

  let res: Response;
  try {
    res = await fetchImpl("https://api.stripe.com/v1/billing/meter_events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (err) {
    // Network/DNS/timeout — always worth retrying.
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore body read failures
    }
    // 4xx (bad customer/meter/params) will fail identically on every retry — treat
    // as permanent so the row doesn't clog the batch. 429 (rate limit) and 5xx are
    // transient and retried with backoff.
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, status: res.status, retryable, error: `stripe ${res.status}: ${detail}` };
  }
  const json = (await res.json()) as { identifier?: string };
  return { ok: true, id: json.identifier ?? params.identifier };
}
