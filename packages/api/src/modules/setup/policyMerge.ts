import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type YamlDoc = Record<string, unknown>;

/**
 * Preserve boot-only policy fields from the active version when the setup wizard
 * generates a slimmer config. Without this, hot reload refuses activation when
 * e.g. `routing.retry` is omitted (see frozenPolicyFieldsFingerprint).
 */
export function preserveBootOnlyPolicyYaml(generatedYaml: string, activeYaml: string): string {
  const next = parseYaml(generatedYaml) as YamlDoc;
  const ref = parseYaml(activeYaml) as YamlDoc;

  const refRouting = ref.routing as YamlDoc | undefined;
  const nextRouting = (next.routing ?? {}) as YamlDoc;
  if (!nextRouting.retry && refRouting?.retry) {
    next.routing = { ...nextRouting, retry: refRouting.retry };
  }

  if (next.pricing == null && ref.pricing != null) {
    next.pricing = ref.pricing;
  }

  const refSafety = ref.safety as YamlDoc | undefined;
  const nextSafety = (next.safety ?? {}) as YamlDoc;
  if (!nextSafety.injection_model && refSafety?.injection_model) {
    next.safety = { ...nextSafety, injection_model: refSafety.injection_model };
  }

  if (next.billing == null && ref.billing != null) {
    next.billing = ref.billing;
  }

  return stringifyYaml(next);
}
