import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  litellmConfigServesDemo,
  readEnvFile,
  runningOnSummary,
} from "../src/setupConfig.js";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "modelgov-setupcfg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readEnvFile", () => {
  it("returns {} for a missing file", () => {
    expect(readEnvFile(".env", tempRoot())).toEqual({});
  });

  it("parses KEY=VALUE pairs, skipping comments and blank lines", () => {
    const r = tempRoot();
    writeFileSync(
      join(r, ".env"),
      "# a comment\n\nMODELGOV_URL=http://localhost:3090\n  \nKEY=value\n",
    );
    expect(readEnvFile(".env", r)).toEqual({
      MODELGOV_URL: "http://localhost:3090",
      KEY: "value",
    });
  });

  it("skips lines with no '=' rather than throwing", () => {
    const r = tempRoot();
    writeFileSync(join(r, ".env"), "JUST_A_WORD\nGOOD=1\n");
    expect(readEnvFile(".env", r)).toEqual({ GOOD: "1" });
  });

  it("strips matching surrounding quotes (else the quote breaks path resolution)", () => {
    const r = tempRoot();
    writeFileSync(
      join(r, ".env"),
      `DOUBLE="./litellm_config.generated.yaml"\nSINGLE='./x.yaml'\n`,
    );
    expect(readEnvFile(".env", r)).toEqual({
      DOUBLE: "./litellm_config.generated.yaml",
      SINGLE: "./x.yaml",
    });
  });

  it("leaves unmatched or inner quotes alone", () => {
    const r = tempRoot();
    writeFileSync(join(r, ".env"), `A="unclosed\nB=say"hi"there\n`);
    expect(readEnvFile(".env", r)).toEqual({ A: `"unclosed`, B: `say"hi"there` });
  });

  it("keeps '=' inside the value (e.g. base64 padding, DSNs)", () => {
    const r = tempRoot();
    writeFileSync(join(r, ".env"), "TOKEN=abc==\nURL=postgres://u:p@h/db?x=1\n");
    expect(readEnvFile(".env", r)).toEqual({
      TOKEN: "abc==",
      URL: "postgres://u:p@h/db?x=1",
    });
  });

  it("handles CRLF line endings", () => {
    const r = tempRoot();
    writeFileSync(join(r, ".env"), "A=1\r\nB=2\r\n");
    expect(readEnvFile(".env", r)).toEqual({ A: "1", B: "2" });
  });
});

// The summary this drives is the last thing `./setup` prints. Claiming "demo AI"
// after the wizard connected a real provider tells the operator their spend is
// fake when it is being billed — so every "is this still demo?" branch is pinned.
describe("litellmConfigServesDemo", () => {
  const GENERATED = "litellm_config.generated.yaml";
  const demoEntry = { model_name: "cheap", litellm_params: { model: "openai/modelgov-demo" } };

  function writeConfig(root: string, doc: unknown, file = GENERATED) {
    writeFileSync(join(root, file), JSON.stringify(doc)); // JSON is valid YAML
  }

  it("treats a missing config as demo (it gets seeded to demo on `up`)", () => {
    expect(litellmConfigServesDemo(tempRoot())).toBe(true);
  });

  it("treats a directory (the Docker land-mine) as demo", () => {
    const r = tempRoot();
    mkdirSync(join(r, GENERATED));
    expect(litellmConfigServesDemo(r)).toBe(true);
  });

  it("treats unparseable YAML as demo rather than over-claiming real spend", () => {
    const r = tempRoot();
    writeFileSync(join(r, GENERATED), "model_list: [unclosed\n  : :\n");
    expect(litellmConfigServesDemo(r)).toBe(true);
  });

  it("treats an empty or absent model_list as demo", () => {
    const r1 = tempRoot();
    writeConfig(r1, { model_list: [] });
    expect(litellmConfigServesDemo(r1)).toBe(true);

    const r2 = tempRoot();
    writeConfig(r2, { general_settings: {} });
    expect(litellmConfigServesDemo(r2)).toBe(true);
  });

  it("is demo when every entry targets the demo sidecar by model name", () => {
    const r = tempRoot();
    writeConfig(r, { model_list: [demoEntry, demoEntry] });
    expect(litellmConfigServesDemo(r)).toBe(true);
  });

  it("is demo when an entry targets the demo sidecar by api_base", () => {
    const r = tempRoot();
    writeConfig(r, {
      model_list: [{ model_name: "cheap", litellm_params: { model: "openai/x", api_base: "http://demo-llm:4001" } }],
    });
    expect(litellmConfigServesDemo(r)).toBe(true);
  });

  it("is REAL as soon as one entry targets a real provider", () => {
    const r = tempRoot();
    writeConfig(r, {
      model_list: [{ model_name: "cheap", litellm_params: { model: "openai/gpt-4o-mini" } }],
    });
    expect(litellmConfigServesDemo(r)).toBe(false);
  });

  it("stays demo when ONLY the hybrid injection guard is present", () => {
    // The injection guard deliberately stays on demo-llm to save free-tier quota;
    // on its own it must not be read as "a real provider is connected".
    const r = tempRoot();
    writeConfig(r, {
      model_list: [
        { model_name: "local/injection-guard", litellm_params: { model: "openai/modelgov-demo", api_base: "http://demo-llm:4001" } },
      ],
    });
    expect(litellmConfigServesDemo(r)).toBe(true);
  });

  it("is REAL when a real model sits alongside the demo injection guard", () => {
    const r = tempRoot();
    writeConfig(r, {
      model_list: [
        { model_name: "local/injection-guard", litellm_params: { model: "openai/modelgov-demo" } },
        { model_name: "cheap", litellm_params: { model: "anthropic/claude-3-5-haiku-latest" } },
      ],
    });
    expect(litellmConfigServesDemo(r)).toBe(false);
  });

  it("treats an entry with no litellm_params as a real target (not demo)", () => {
    const r = tempRoot();
    writeConfig(r, { model_list: [{ model_name: "cheap" }] });
    expect(litellmConfigServesDemo(r)).toBe(false);
  });

  it("follows LITELLM_CONFIG_PATH from .env, including a quoted value", () => {
    const r = tempRoot();
    // The generated file says demo; the configured override says real. The
    // override must win, quotes and leading "./" notwithstanding.
    writeConfig(r, { model_list: [demoEntry] });
    writeConfig(r, { model_list: [{ litellm_params: { model: "groq/llama-3.1-8b-instant" } }] }, "custom.yaml");
    writeFileSync(join(r, ".env"), `LITELLM_CONFIG_PATH="./custom.yaml"\n`);
    expect(litellmConfigServesDemo(r)).toBe(false);
  });

  it("falls back to the generated config when LITELLM_CONFIG_PATH is blank", () => {
    const r = tempRoot();
    writeConfig(r, { model_list: [{ litellm_params: { model: "openai/gpt-4o" } }] });
    writeFileSync(join(r, ".env"), "LITELLM_CONFIG_PATH=   \n");
    expect(litellmConfigServesDemo(r)).toBe(false);
  });

  it("reports demo when LITELLM_CONFIG_PATH points at a file that isn't there", () => {
    const r = tempRoot();
    writeFileSync(join(r, ".env"), "LITELLM_CONFIG_PATH=./never-written.yaml\n");
    expect(litellmConfigServesDemo(r)).toBe(true);
  });
});

describe("runningOnSummary", () => {
  it("names the real backend for each explicit mode", () => {
    expect(runningOnSummary("cloud")).toMatch(/cloud provider keys/);
    expect(runningOnSummary("azure")).toMatch(/Azure OpenAI/);
    expect(runningOnSummary("local")).toMatch(/local Ollama/);
    expect(runningOnSummary("prod")).toMatch(/production mode/);
  });

  it("says demo for simple/full when the config still serves demo", () => {
    expect(runningOnSummary("simple", { servesDemo: true })).toMatch(/built-in demo AI/);
    expect(runningOnSummary("full", { servesDemo: true })).toMatch(/built-in demo AI/);
  });

  it("warns about real billing once a provider is connected", () => {
    const msg = runningOnSummary("simple", { servesDemo: false });
    expect(msg).toMatch(/connected provider/);
    expect(msg).toMatch(/billed/);
  });

  it("defaults to the demo wording when servesDemo is unknown", () => {
    // Unknown must never claim real spend — the conservative branch is "demo".
    expect(runningOnSummary("simple")).toMatch(/built-in demo AI/);
    expect(runningOnSummary("simple", {})).toMatch(/built-in demo AI/);
  });
});
