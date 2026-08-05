import type { Provider } from "create-modelgov/render";
import type { TemplateId } from "create-modelgov/templates";
import type { BackendMode } from "./catalog";
import type { Step } from "./flow";

const SETUP_KEY = "modelgov-setup-v1-complete";
const WIZARD_STATE_KEY = "modelgov-setup-wizard-state-v1";

export function isSetupComplete(): boolean {
  // Guarded: a throwing localStorage (private mode / disabled) must not crash the
  // App setup gate. Treat unavailable storage as "not yet complete".
  try {
    return localStorage.getItem(SETUP_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_KEY, "1");
    // Drop the in-progress wizard state once setup is finished.
    sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch {
    /* ignore storage errors (private mode, quota, disabled) */
  }
}

/** Non-secret wizard selections, persisted so an accidental refresh doesn't lose
 *  progress. Secrets are NEVER persisted. */
export interface PersistedWizard {
  step: Step;
  templateId: TemplateId;
  backend: BackendMode;
  providers: Provider[];
  safety: "dev" | "balanced" | "strict";
  monthlyBudget: number;
  customBudget: boolean;
  quickStart: boolean;
}

export function loadWizardState(): Partial<PersistedWizard> {
  try {
    const raw = sessionStorage.getItem(WIZARD_STATE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedWizard>) : {};
  } catch {
    return {};
  }
}

/**
 * Persist ONLY the declared fields. Serialising the argument wholesale would
 * write whatever it carries, so "secrets are never persisted" would depend
 * entirely on the caller's type being exact — and excess-property checking does
 * not apply to a value that reached the caller through a wider type. Picking
 * the fields explicitly makes the guarantee structural.
 */
export function saveWizardState(state: PersistedWizard): void {
  const safe: PersistedWizard = {
    step: state.step,
    templateId: state.templateId,
    backend: state.backend,
    providers: state.providers,
    safety: state.safety,
    monthlyBudget: state.monthlyBudget,
    customBudget: state.customBudget,
    quickStart: state.quickStart,
  };
  try {
    sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(safe));
  } catch {
    /* ignore storage errors (private mode, quota) */
  }
}

/** Restore the saved step, but never strand the user: don't reopen provider/key
 *  steps that don't apply to the saved backend, and never restore into "done". */
export function safeRestoredStep(p: Partial<PersistedWizard>): Step {
  const s = p.step;
  if (!s || s === "done") return "welcome";
  if ((s === "providers" || s === "keys") && p.backend !== "cloud") return "welcome";
  return s;
}
