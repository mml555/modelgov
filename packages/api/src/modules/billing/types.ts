import type { BillingConfig, BillingMode } from "@modelgov/policy-engine";

export interface BillingBalance {
  userId: string;
  creditsUsd: number;
  creditsReservedUsd: number;
  creditsAvailableUsd: number;
  userType: string | null;
  stripeCustomerId: string | null;
  mode: BillingMode;
}

export interface BillingServiceConfig {
  billing?: BillingConfig;
  /** Env-resolved Stripe secret (overrides yaml secret_key). */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
}
