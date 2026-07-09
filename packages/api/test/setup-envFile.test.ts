import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvFileError, mergeEnvFile } from "../src/modules/setup/envFile";

describe("mergeEnvFile", () => {
  it("creates and updates keys in a dotenv file", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-env-"));
    const path = join(dir, ".env");
    try {
      mergeEnvFile(path, { OPENAI_API_KEY: "sk-one" });
      mergeEnvFile(path, { ANTHROPIC_API_KEY: "sk-ant-two", OPENAI_API_KEY: "sk-updated" });
      const text = readFileSync(path, "utf8");
      expect(text).toContain("OPENAI_API_KEY=sk-updated");
      expect(text).toContain("ANTHROPIC_API_KEY=sk-ant-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects newline-injecting values and invalid keys without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-env-"));
    const path = join(dir, ".env");
    try {
      expect(() => mergeEnvFile(path, { OPENAI_API_KEY: "sk-x\nEVIL=1" })).toThrow(EnvFileError);
      expect(() => mergeEnvFile(path, { "BAD KEY": "v" })).toThrow(EnvFileError);
      // The rejected write must not have created/altered the file.
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
