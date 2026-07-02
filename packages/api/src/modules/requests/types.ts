export type RequestLogStatus = "completed" | "blocked" | "safety_blocked" | "error";

export interface RequestRecord {
  id: string;
  status: RequestLogStatus;
  decision: string;
  reasonCode?: string;
  reason?: string;
  feature: string;
  userType?: string;
  userId?: string;
  projectId?: string;
  environment?: string;
  requestedModelClass?: string;
  resolvedModelClass?: string;
  provider?: string;
  model?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  safety: {
    pii: "masked" | "blocked" | "none";
    promptInjection: "blocked" | "passed";
  };
  timestamps: {
    createdAt: string;
  };
  /** Host-app metadata attached to the original chat call. */
  metadata?: Record<string, unknown>;
  /** Which policy produced this decision. */
  policy?: {
    configHash?: string;
    policyVersion?: string;
  };
}

export interface RequestListQuery {
  userId?: string;
  feature?: string;
  userType?: string;
  status?: RequestLogStatus;
  reasonCode?: string;
  since?: string;
  limit?: number;
  projectId?: string;
}

export interface RequestListResponse {
  items: RequestRecord[];
  limit: number;
}
