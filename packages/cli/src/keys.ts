import { clientFromEnv } from "./api.js";

interface KeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  projectId?: string;
  environment?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

interface IssuedKey extends KeyRecord {
  secret: string;
}

const USAGE = `modelgov keys — manage DB-backed API keys (requires a keys:admin key)

Usage:
  modelgov keys list [--include-revoked] [--project <id>]
  modelgov keys create --name <name> [--permissions chat:create,usage:read]
                       [--project <id>] [--environment <env>] [--expires <iso8601>]
  modelgov keys rotate <id>
  modelgov keys revoke <id>

Auth: set MODELGOV_API_KEY to a key with the keys:admin permission,
and MODELGOV_URL to the API base URL (default http://localhost:3000).
`;

export async function runKeysCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(USAGE);
    return;
  }

  const client = clientFromEnv();

  switch (sub) {
    case "list": {
      const includeRevoked = args.includes("--include-revoked");
      const projectId = flagValue(args, "--project");
      const { items } = await client.getJson<{ items: KeyRecord[] }>("/v1/admin/keys", {
        includeRevoked: includeRevoked ? "true" : undefined,
        projectId,
      });
      if (items.length === 0) {
        console.log("No keys.");
        return;
      }
      for (const k of items) {
        const state = k.revokedAt ? "revoked" : k.expiresAt ? `expires ${k.expiresAt}` : "active";
        console.log(
          `${k.id}  ${k.keyPrefix}…  ${k.name}  [${k.permissions.join(",")}]  ${state}`,
        );
      }
      return;
    }
    case "create": {
      const name = flagValue(args, "--name");
      if (!name) throw new Error("--name is required");
      const permissions = flagValue(args, "--permissions")?.split(",").map((s) => s.trim()).filter(Boolean);
      const issued = await client.postJson<IssuedKey>("/v1/admin/keys", {
        name,
        permissions,
        projectId: flagValue(args, "--project"),
        environment: flagValue(args, "--environment"),
        expiresAt: flagValue(args, "--expires"),
      });
      console.log(`Created key ${issued.id} (${issued.name}).`);
      console.log(`\nSecret (shown once — store it now):\n  ${issued.secret}\n`);
      return;
    }
    case "rotate": {
      const id = requireId(args[1]);
      const issued = await client.postJson<IssuedKey>(`/v1/admin/keys/${id}/rotate`);
      console.log(`Rotated key ${issued.id}.`);
      console.log(`\nNew secret (shown once — store it now):\n  ${issued.secret}\n`);
      return;
    }
    case "revoke": {
      const id = requireId(args[1]);
      await client.postJson(`/v1/admin/keys/${id}/revoke`);
      console.log(`Revoked key ${id}.`);
      return;
    }
    default:
      throw new Error(`Unknown keys subcommand: ${sub}`);
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function requireId(id: string | undefined): string {
  if (!id || id.startsWith("--")) throw new Error("a key id is required");
  return id;
}
