import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/index";

// Compile-time guard: a consumer with their OWN feature/userType/modelClass
// names (not this repo's demo config) must be able to construct a request. If
// the generated unions ever go closed again, `tsc` fails here — which is the
// bug (the published SDK becoming unusable off-repo) caught at build time.
const _externalConsumerRequest: ChatRequest = {
  userId: "u1",
  userType: "enterprise_seat",
  feature: "invoice_summarizer",
  modelClass: "frontier",
  messages: [{ role: "user", content: "hi" }],
};
void _externalConsumerRequest;

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GENERATED = resolve(
  ROOT,
  "packages/sdk-typescript/src/generated/config-types.ts",
);

function extractUnion(name: string, source: string): string[] {
  const re = new RegExp(
    `export type ${name} = ([^;]+);`,
  );
  const match = source.match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split("|")
    .map((s) => s.trim())
    // Keep only quoted string-literal members; the union is widened with a
    // `(string & {})` member so external configs compile — that is not a
    // registered identifier and must not be compared against the yaml keys.
    .filter((s) => /^"[^"]*"$/.test(s))
    .map((s) => s.replace(/^"|"$/g, ""));
}

describe("generated SDK config types", () => {
  it("matches feature and user_type keys from ai-guard.yaml", () => {
    const yaml = readFileSync(resolve(ROOT, "ai-guard.yaml"), "utf8");
    const config = parseConfig(yaml);
    const generated = readFileSync(GENERATED, "utf8");

    expect(extractUnion("FeatureName", generated).sort()).toEqual(
      Object.keys(config.features).sort(),
    );
    expect(extractUnion("UserTypeName", generated).sort()).toEqual(
      Object.keys(config.budgets.byUserType).sort(),
    );
    expect(extractUnion("ModelClassName", generated).sort()).toEqual(
      Object.keys(config.modelClasses).sort(),
    );
  });
});
