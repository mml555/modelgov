import type { Pool } from "pg";
import { getEmergencyPause } from "./repo";

/**
 * Hot-path pause gate for data-plane requests (chat, embeddings). A request is
 * paused when the platform-wide switch is on OR the caller's tenant switch is on.
 * Lives in the service layer — routes.ts owns only the admin endpoints.
 *
 * An unbound request (no tenant binding, tenantId undefined) resolves to the
 * default (untenanted) partition — the "" sentinel — NOT "platform only". This
 * mirrors resolveTenantScope so the check honors a default-partition pause set by
 * an operator confined to it (an unbound admin without tenant:switch pauses "",
 * not platform-wide). getEmergencyPause always also checks the platform switch,
 * so a genuine platform-wide pause still blocks every request.
 */
export async function assertAiRequestsNotPaused(
  pool: Pool,
  tenantId?: string,
): Promise<{
  paused: boolean;
  reason?: string;
}> {
  const state = await getEmergencyPause(pool, tenantId ?? "");
  if (!state.paused) return { paused: false };
  return { paused: true, reason: state.reason };
}
