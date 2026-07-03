#!/usr/bin/env tsx
/**
 * End-to-end smoke: scaffold a project in a temp dir and validate generated config.
 * Used in CI to catch regressions in create-modelgov output.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../packages/policy-engine/src/index.ts";
import { buildScaffold } from "../packages/create-modelgov/src/scaffold.ts";
import { TEMPLATES } from "../packages/create-modelgov/src/templates.ts";

const dir = mkdtempSync(join(tmpdir(), "modelgov-scaffold-"));
try {
  const files = buildScaffold({
    projectName: "ci-smoke",
    framework: "nextjs",
    providers: ["openai"],
    mode: "simple",
    safetyPreset: "balanced",
    template: TEMPLATES.support_chat,
  });

  const yaml = files.get("modelgov.yaml");
  if (!yaml) throw new Error("missing modelgov.yaml");
  parseConfig(yaml);

  const litellm = files.get("litellm_config.yaml");
  if (!litellm?.includes("openai/gpt-4o-mini")) {
    throw new Error("litellm_config.yaml missing expected model");
  }

  const smoke = files.get("scripts/smoke.mjs");
  if (!smoke?.includes("support_chat")) throw new Error("smoke script missing feature");

  console.log("ok scaffold smoke:", dir, `(${files.size} files)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
