import { describe, expect, it } from "vitest";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { WIZARD_PROVIDERS, type Provider } from "create-modelgov/render";
import { TEMPLATES } from "create-modelgov/templates";
import {
  ADVANCED_PROVIDER_NOTES,
  ALL_WIZARD_PROVIDERS,
  BACKEND_OPTIONS,
  BEGINNER_PRESET,
  BUDGET_PRESETS,
  CREDENTIAL_FIELDS,
  FREE_TIER_INJECTION_PROVIDERS,
  PROVIDER_GROUPS,
  SAFETY_OPTIONS,
  TEMPLATE_CHOICES,
  advancedNotesForProviders,
  credentialFieldsForProviders,
  providerSummary,
  shouldShowHybridInjectionGuidance,
} from "../src/setup/catalog";

// These are drift guards as much as unit tests. The wizard's provider catalog is
// hand-written but every value in it (labels, credential env vars, models) is
// owned by PROVIDER_REGISTRY / WIZARD_PROVIDERS. When those move and the catalog
// doesn't, the UI renders a dead provider card or an unlabeled key field — which
// is exactly how the cloud-provider config bugs reached users. Assert the
// relationship, not the current contents, so the guard survives adding providers.

const groupedProviders = PROVIDER_GROUPS.flatMap((g) => g.providers);

describe("PROVIDER_GROUPS", () => {
  it("only lists providers the wizard actually supports", () => {
    for (const p of groupedProviders) {
      expect(WIZARD_PROVIDERS, `${p} is grouped but not a wizard provider`).toContain(p);
    }
  });

  it("every provider resolves in the registry (no dead cards)", () => {
    for (const p of groupedProviders) {
      expect(PROVIDER_REGISTRY[p], `${p} has no registry entry`).toBeDefined();
    }
  });

  it("covers every wizard provider — none is unreachable in the UI", () => {
    for (const p of WIZARD_PROVIDERS) {
      expect(groupedProviders, `${p} is supported but in no group`).toContain(p);
    }
  });

  it("lists each provider exactly once (no duplicate cards)", () => {
    expect(new Set(groupedProviders).size).toBe(groupedProviders.length);
  });

  it("uses unique group ids and non-empty copy", () => {
    const ids = PROVIDER_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of PROVIDER_GROUPS) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(0);
      expect(g.providers.length).toBeGreaterThan(0);
    }
  });

  it("re-exports the wizard provider list verbatim", () => {
    expect(ALL_WIZARD_PROVIDERS).toBe(WIZARD_PROVIDERS);
  });
});

describe("credentialFieldsForProviders", () => {
  it("returns one field per credential env var of the provider", () => {
    const fields = credentialFieldsForProviders(["openai"]);
    expect(fields.map((f) => f.key)).toEqual(PROVIDER_REGISTRY.openai.credentialEnvVars);
    expect(fields[0]?.providerLabel).toBe(PROVIDER_REGISTRY.openai.label);
  });

  it("returns nothing for no providers", () => {
    expect(credentialFieldsForProviders([])).toEqual([]);
  });

  it("de-duplicates an env var shared by two selected providers", () => {
    // bedrock and vertex_ai both surface multiple vars; picking two providers must
    // never ask the operator to paste the same env var twice.
    const fields = credentialFieldsForProviders([...WIZARD_PROVIDERS]);
    const keys = fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("attributes a shared env var to the FIRST provider that needs it", () => {
    const forward = credentialFieldsForProviders(["azure", "azure_ai"]);
    const shared = forward.find((f) => f.key === "AZURE_API_KEY");
    expect(shared?.provider).toBe("azure");
  });

  it("marks only genuinely optional credentials optional", () => {
    const fields = credentialFieldsForProviders([...WIZARD_PROVIDERS]);
    const optional = fields.filter((f) => f.optional).map((f) => f.key).sort();
    expect(optional).toEqual(["AWS_SESSION_TOKEN", "GITHUB_COPILOT_TOKEN"]);
  });

  it("has a human label for every credential the wizard can ask for", () => {
    // The fallback (env-var-name-as-label) is a safety net, not a shipping state:
    // a new registry credential must get real copy in CREDENTIAL_FIELDS.
    for (const p of WIZARD_PROVIDERS) {
      for (const envVar of PROVIDER_REGISTRY[p].credentialEnvVars) {
        expect(CREDENTIAL_FIELDS[envVar], `${envVar} (${p}) has no human label`).toBeDefined();
      }
    }
  });

  it("never emits blank copy for a field", () => {
    for (const f of credentialFieldsForProviders([...WIZARD_PROVIDERS])) {
      expect(f.label.length, `${f.key} label`).toBeGreaterThan(0);
      expect(f.help.length, `${f.key} help`).toBeGreaterThan(0);
      expect(f.placeholder.length, `${f.key} placeholder`).toBeGreaterThan(0);
    }
  });

  it("asks for nothing (rather than throwing) on an unregistered provider", () => {
    // The derived-label fallback inside the loop is deliberately NOT asserted
    // here: it is unreachable with shipped data (see the label-coverage test
    // above), and faking a registry entry to reach it would test the fake.
    expect(credentialFieldsForProviders(["not_a_provider" as Provider])).toEqual([]);
  });
});

describe("providerSummary", () => {
  it("joins registry labels, not raw slugs", () => {
    expect(providerSummary(["openai", "anthropic"])).toBe(
      `${PROVIDER_REGISTRY.openai.label}, ${PROVIDER_REGISTRY.anthropic.label}`,
    );
  });

  it("falls back to the slug for an unknown provider", () => {
    expect(providerSummary(["mystery" as Provider])).toBe("mystery");
  });

  it("is empty for no providers", () => {
    expect(providerSummary([])).toBe("");
  });
});

describe("advancedNotesForProviders", () => {
  it("returns notes only for providers that have one", () => {
    expect(advancedNotesForProviders(["openai"])).toEqual([]);
    expect(advancedNotesForProviders(["vertex_ai"])).toEqual([
      ADVANCED_PROVIDER_NOTES.vertex_ai,
    ]);
  });

  it("collects notes for several providers, dropping the ones without", () => {
    const notes = advancedNotesForProviders(["openai", "azure", "vertex_ai"]);
    expect(notes).toHaveLength(2);
    expect(notes).toContain(ADVANCED_PROVIDER_NOTES.azure);
  });

  it("is keyed only by real wizard providers", () => {
    for (const p of Object.keys(ADVANCED_PROVIDER_NOTES)) {
      expect(WIZARD_PROVIDERS, `note for unknown provider ${p}`).toContain(p);
    }
  });
});

describe("shouldShowHybridInjectionGuidance", () => {
  const base = { useCloud: true, safety: "balanced" as const, providers: ["gemini" as Provider] };

  it("shows for a free-tier provider with safety on", () => {
    expect(shouldShowHybridInjectionGuidance(base)).toBe(true);
    expect(shouldShowHybridInjectionGuidance({ ...base, safety: "strict" })).toBe(true);
  });

  it("hides when safety is off (no injection call to save)", () => {
    expect(shouldShowHybridInjectionGuidance({ ...base, safety: "dev" })).toBe(false);
  });

  it("hides when not using a cloud provider", () => {
    expect(shouldShowHybridInjectionGuidance({ ...base, useCloud: false })).toBe(false);
  });

  it("hides for providers without a tight free tier", () => {
    expect(shouldShowHybridInjectionGuidance({ ...base, providers: ["openai"] })).toBe(false);
    expect(shouldShowHybridInjectionGuidance({ ...base, providers: [] })).toBe(false);
  });

  it("shows when only one of several providers is free-tier", () => {
    expect(
      shouldShowHybridInjectionGuidance({ ...base, providers: ["openai", "groq"] }),
    ).toBe(true);
  });

  it("only names real wizard providers as free-tier", () => {
    for (const p of FREE_TIER_INJECTION_PROVIDERS) {
      expect(WIZARD_PROVIDERS).toContain(p);
    }
  });
});

describe("wizard option tables", () => {
  it("TEMPLATE_CHOICES mirrors the shipped templates and recommends exactly one", () => {
    for (const c of TEMPLATE_CHOICES) {
      expect(TEMPLATES[c.id], `${c.id} is not a shipped template`).toBeDefined();
      expect(c.description).toBe(TEMPLATES[c.id].description);
      expect(c.localOnly).toBe(TEMPLATES[c.id].localOnly === true);
      // The friendly title drops the "— tagline" suffix, so it must be shorter
      // than the raw label and never empty.
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.title).not.toContain("—");
    }
    expect(TEMPLATE_CHOICES.filter((c) => c.recommended)).toHaveLength(1);
  });

  it("BEGINNER_PRESET points at a real template and a real safety preset", () => {
    expect(TEMPLATES[BEGINNER_PRESET.templateId]).toBeDefined();
    expect(SAFETY_OPTIONS.map((s) => s.id)).toContain(BEGINNER_PRESET.safety);
    expect(BACKEND_OPTIONS.map((b) => b.id)).toContain(BEGINNER_PRESET.backend);
    expect(BEGINNER_PRESET.monthlyBudget).toBeGreaterThan(0);
  });

  it("BACKEND_OPTIONS and SAFETY_OPTIONS have unique ids and real copy", () => {
    for (const table of [BACKEND_OPTIONS, SAFETY_OPTIONS]) {
      const ids = table.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of table) {
        expect(o.title.length).toBeGreaterThan(0);
        expect(o.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("recommends exactly one backend, and it is the real-provider path", () => {
    const badged = BACKEND_OPTIONS.filter((b) => b.badge);
    expect(badged).toHaveLength(1);
    // Governing fake demo tokens teaches nothing about cost — the recommended
    // path must be a real provider. See the BEGINNER_PRESET rationale.
    expect(badged[0]?.id).toBe("cloud");
    expect(badged[0]?.id).toBe(BEGINNER_PRESET.backend);
  });

  it("BUDGET_PRESETS ascend and include the beginner default", () => {
    const values = BUDGET_PRESETS.map((b) => b.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.every((v) => v > 0)).toBe(true);
    expect(values).toContain(BEGINNER_PRESET.monthlyBudget);
  });
});
