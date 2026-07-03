import type {
  ModelgovConfig,
  FeatureConfig,
  InjectionMode,
  PiiMode,
  PiiScope,
  ProtectConfig,
  SafetyPlan,
  SafetyPresetName,
} from "./types";

// Per-preset defaults. The pure engine resolves WHICH protections apply; the
// API's Safety service performs the actual I/O enforcement.
export const PRESET_DEFAULTS: Record<
  SafetyPresetName,
  Required<ProtectConfig>
> = {
  dev: { pii: "off", piiScope: "both", promptInjection: "off" },
  balanced: { pii: "mask", piiScope: "both", promptInjection: "block" },
  strict: { pii: "block", piiScope: "both", promptInjection: "block" },
  // "custom" defaults to off; rely on explicit `protect:` to opt in.
  custom: { pii: "off", piiScope: "both", promptInjection: "off" },
};

/**
 * Resolve the effective safety plan for a request. Precedence, most specific
 * first:
 *   1. explicit feature.protect
 *   2. feature preset default  (only when the feature overrides the preset)
 *   3. explicit global.protect
 *   4. global preset default
 *
 * Key point: a feature that selects a *stricter preset* outranks the global
 * explicit protect — choosing "strict" on a feature really does tighten it,
 * even if the global config explicitly set a looser value.
 */
export function resolveSafetyPlan(
  config: ModelgovConfig,
  feature: FeatureConfig,
): SafetyPlan {
  const override = feature.safety;
  const globalPreset = config.safety.preset;
  const effectivePreset: SafetyPresetName = override?.preset ?? globalPreset;

  // Global-scope effective value: explicit global protect, else global preset default.
  const globalPii: PiiMode =
    config.safety.protect.pii ?? PRESET_DEFAULTS[globalPreset].pii;
  const globalInjection: InjectionMode =
    config.safety.protect.promptInjection ??
    PRESET_DEFAULTS[globalPreset].promptInjection;

  // Feature-scope value: explicit feature protect, else the feature preset's
  // default (undefined when the feature didn't override the preset).
  const featurePii: PiiMode | undefined =
    override?.protect?.pii ??
    (override?.preset ? PRESET_DEFAULTS[override.preset].pii : undefined);
  const featureInjection: InjectionMode | undefined =
    override?.protect?.promptInjection ??
    (override?.preset
      ? PRESET_DEFAULTS[override.preset].promptInjection
      : undefined);

  // Grounding: feature override wins, else the global default, else off.
  const grounding = override?.grounding ?? config.safety.grounding ?? "off";

  // PII scope: same 4-tier precedence as pii/promptInjection —
  // feature-explicit → feature-preset default → global-explicit → global-preset
  // default. Omitting the feature-preset tier (the old bug) let a feature that
  // escalated to a stricter preset silently keep the global scope, leaving one
  // side of that "strict" feature unmasked.
  const piiScope: PiiScope =
    override?.protect?.piiScope ??
    (override?.preset ? PRESET_DEFAULTS[override.preset].piiScope : undefined) ??
    config.safety.protect.piiScope ??
    PRESET_DEFAULTS[globalPreset].piiScope;

  return {
    preset: effectivePreset,
    pii: featurePii ?? globalPii,
    piiScope,
    promptInjection: featureInjection ?? globalInjection,
    injectionModel: config.safety.injectionModel,
    maxOutputTokens: feature.maxTokens,
    grounding,
  };
}
