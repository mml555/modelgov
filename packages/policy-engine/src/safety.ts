import type {
  ModelgovConfig,
  FeatureConfig,
  InjectionMode,
  PiiMode,
  PiiScope,
  ProtectConfig,
  SafetyPlan,
  SafetyPresetName,
  PiiEntityPolicy,
} from "./types";

// Per-preset defaults. The pure engine resolves WHICH protections apply; the
// API's Safety service performs the actual I/O enforcement.
// Presets are coarse by definition — per-entity policy is always explicit, so
// it is excluded here rather than given a meaningless preset default.
export const PRESET_DEFAULTS: Record<
  SafetyPresetName,
  Required<Omit<ProtectConfig, "piiEntities">>
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
  // `pii` and `piiEntities` resolve as ONE unit at whichever tier supplies the
  // mode. Resolving them independently would let a feature that writes the
  // plain `pii: mask` silently inherit the global's per-entity allowances —
  // i.e. keep passing PERSON through on a feature whose author asked for a
  // blanket mask.
  type PiiSetting = { mode: PiiMode; entities?: PiiEntityPolicy };
  const globalPiiSetting: PiiSetting = config.safety.protect.pii
    ? { mode: config.safety.protect.pii, entities: config.safety.protect.piiEntities }
    : { mode: PRESET_DEFAULTS[globalPreset].pii };
  const globalPii: PiiMode = globalPiiSetting.mode;
  const globalInjection: InjectionMode =
    config.safety.protect.promptInjection ??
    PRESET_DEFAULTS[globalPreset].promptInjection;

  // Feature-scope value: explicit feature protect, else the feature preset's
  // default (undefined when the feature didn't override the preset).
  const featurePiiSetting: PiiSetting | undefined = override?.protect?.pii
    ? { mode: override.protect.pii, entities: override.protect.piiEntities }
    : override?.preset
      ? { mode: PRESET_DEFAULTS[override.preset].pii }
      : undefined;
  const featurePii: PiiMode | undefined = featurePiiSetting?.mode;
  const featureInjection: InjectionMode | undefined =
    override?.protect?.promptInjection ??
    (override?.preset
      ? PRESET_DEFAULTS[override.preset].promptInjection
      : undefined);

  // Grounding: the feature's block replaces the global one WHOLESALE (not a
  // field-by-field merge), so a feature that sets its own persona can never be
  // left carrying a refusal string written for a different desk.
  const groundingConfig = override?.grounding ?? config.safety.grounding;
  const grounding = groundingConfig?.mode ?? "off";

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

  const piiSetting = featurePiiSetting ?? globalPiiSetting;

  return {
    preset: effectivePreset,
    pii: featurePii ?? globalPii,
    // Absent unless per-entity policy was actually configured, so a plan can be
    // read as "coarse mode" without checking for an empty object.
    ...(piiSetting.entities ? { piiEntities: piiSetting.entities } : {}),
    piiScope,
    promptInjection: featureInjection ?? globalInjection,
    injectionModel: config.safety.injectionModel,
    maxOutputTokens: feature.maxTokens,
    grounding,
    // Only when it can actually apply — carrying copy for an off feature would
    // suggest, wrongly, that something is enforcing it.
    ...(grounding === "strict" && groundingConfig
      ? {
          groundingOptions: {
            persona: groundingConfig.persona,
            refusal: groundingConfig.refusal,
            cite: groundingConfig.cite,
          },
        }
      : {}),
  };
}
