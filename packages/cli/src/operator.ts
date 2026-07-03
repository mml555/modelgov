import { clientFromEnv } from "./api.js";

interface RequestRecord {
  id: string;
  status: string;
  decision: string;
  reason?: string;
  reasonCode?: string;
  feature: string;
  userType?: string;
  userId?: string;
  model?: string;
  actualCostUsd?: number;
  timestamps: { createdAt: string };
}

interface RequestListResponse {
  items: RequestRecord[];
  limit: number;
}

interface UsageSummaryReport {
  since: string;
  feature?: string;
  userType?: string;
  requests: number;
  completed: number;
  blocked: number;
  degraded: number;
  fallbacks: number;
  safetyBlocked: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  topReasonCode?: { code: string; count: number };
  topModel?: { model: string; count: number };
}

export async function runRequestsCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(REQUESTS_USAGE);
    return;
  }

  const client = clientFromEnv();
  const json = args.includes("--json");

  if (sub === "list") {
    const query = parseListFlags(args.slice(1));
    const res = await client.getJson<RequestListResponse>("/v1/requests", query);
    if (json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (res.items.length === 0) {
      console.log("No requests found.");
      return;
    }
    for (const item of res.items) {
      console.log(formatRequestLine(item));
    }
    console.log(`\n${res.items.length} shown (limit ${res.limit})`);
    return;
  }

  if (sub === "show") {
    const id = args[1];
    if (!id || id.startsWith("--")) {
      throw new Error("usage: modelgov requests show <req_id>");
    }
    const record = await client.getJson<RequestRecord>(`/v1/requests/${id}`);
    if (json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    console.log(formatRequestDetail(record));
    return;
  }

  throw new Error(`Unknown requests subcommand: ${sub}`);
}

export async function runUsageSummaryCommand(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE_SUMMARY_HELP);
    return;
  }

  const client = clientFromEnv();
  const json = args.includes("--json");
  const report = await client.getJson<UsageSummaryReport>("/v1/usage/summary", {
    feature: flagValue(args, "--feature"),
    userType: flagValue(args, "--userType"),
    since: flagValue(args, "--since") ?? "24h",
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatUsageSummary(report));
}

function parseListFlags(args: string[]): Record<string, string | undefined> {
  return {
    userId: flagValue(args, "--userId"),
    feature: flagValue(args, "--feature"),
    userType: flagValue(args, "--userType"),
    status: flagValue(args, "--status"),
    reasonCode: flagValue(args, "--reason"),
    since: flagValue(args, "--since"),
    limit: flagValue(args, "--limit"),
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function formatRequestLine(item: RequestRecord): string {
  const cost = item.actualCostUsd != null ? `$${item.actualCostUsd.toFixed(6)}` : "-";
  const reason = item.reasonCode ? ` ${item.reasonCode}` : "";
  return `${item.id}  ${item.status.padEnd(14)} ${item.feature.padEnd(20)} ${item.userType ?? "-"}  ${cost}${reason}`;
}

function formatRequestDetail(record: RequestRecord): string {
  const lines = [
    `ID:       ${record.id}`,
    `Status:   ${record.status}`,
    `Decision: ${record.decision}`,
  ];
  if (record.reasonCode) lines.push(`Reason:   ${record.reasonCode}`);
  if (record.reason) lines.push(`Detail:   ${record.reason}`);
  lines.push(`Feature:  ${record.feature}`);
  if (record.userType) lines.push(`User:     ${record.userId ?? "-"} (${record.userType})`);
  if (record.model) lines.push(`Model:    ${record.model}`);
  if (record.actualCostUsd != null) lines.push(`Cost:     $${Number(record.actualCostUsd).toFixed(6)}`);
  lines.push(`At:       ${record.timestamps.createdAt}`);
  return lines.join("\n");
}

function formatUsageSummary(report: UsageSummaryReport): string {
  const lines = [
    report.feature ? `Feature: ${report.feature}` : "All features",
    report.userType ? `User type: ${report.userType}` : "All user types",
    `Since: ${report.since}`,
    "",
    `Requests:  ${report.requests}`,
    `Completed: ${report.completed}`,
    `Blocked:   ${report.blocked}`,
    `Degraded:  ${report.degraded}`,
    `Fallbacks: ${report.fallbacks}`,
    `Safety:    ${report.safetyBlocked}`,
    `Actual cost: $${report.actualCostUsd.toFixed(4)}`,
    `Estimated:   $${report.estimatedCostUsd.toFixed(4)}`,
  ];
  if (report.topReasonCode) {
    lines.push(`Top block reason: ${report.topReasonCode.code} (${report.topReasonCode.count})`);
  }
  if (report.topModel) {
    lines.push(`Top model: ${report.topModel.model} (${report.topModel.count})`);
  }
  return lines.join("\n");
}

const REQUESTS_USAGE = `modelgov requests — inspect audit logs (metadata only)

Usage:
  modelgov requests list [filters]
  modelgov requests show <req_id>

List filters:
  --userId <id>
  --feature <name>
  --userType <type>
  --status completed|blocked|safety_blocked|error
  --reason <reasonCode>
  --since 24h|7d|ISO-8601
  --limit <n>
  --json
`;

const USAGE_SUMMARY_HELP = `modelgov usage summary [options]

Options:
  --feature <name>
  --userType <type>
  --since 24h|7d|ISO-8601   (default: 24h)
  --json
`;
