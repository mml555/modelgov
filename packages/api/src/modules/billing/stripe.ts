import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const sigPart = parts.find((p) => p.startsWith("v1="));
  if (!timestampPart || !sigPart) return false;

  const timestamp = Number(timestampPart.slice(2));
  const expectedSig = sigPart.slice(3);
  if (!Number.isFinite(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSec) return false;

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

export interface StripeCheckoutSession {
  id: string;
  customer?: string | null;
  metadata?: Record<string, string>;
  amount_total?: number | null;
  currency?: string | null;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
}

export interface StripeInvoice {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  status?: string | null;
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
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const body = new URLSearchParams({
    event_name: params.eventName,
    "payload[stripe_customer_id]": params.stripeCustomerId,
    "payload[value]": String(params.value),
    identifier: params.identifier,
  });

  const res = await fetchImpl("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) return null;
  const json = (await res.json()) as { identifier?: string };
  return json.identifier ?? params.identifier;
}
