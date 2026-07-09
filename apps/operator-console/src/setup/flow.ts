import type { BackendMode } from "./catalog";

export type Step =
  | "welcome"
  | "template"
  | "backend"
  | "providers"
  | "keys"
  | "limits"
  | "review"
  | "done";

export const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Start" },
  { id: "template", label: "Use case" },
  { id: "backend", label: "AI source" },
  { id: "providers", label: "Providers" },
  { id: "keys", label: "Keys" },
  { id: "limits", label: "Limits" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.id === step);
}

/** Steps shown in the progress bar for the chosen backend/template. */
export function getVisibleSteps(backend: BackendMode, templateLocalOnly: boolean): typeof STEPS {
  return STEPS.filter((s) => {
    if (s.id === "welcome" || s.id === "done") return true;
    if (s.id === "providers" || s.id === "keys") return backend === "cloud" && !templateLocalOnly;
    if (s.id === "backend" && templateLocalOnly) return false;
    return true;
  });
}

interface FlowOpts {
  backend: BackendMode;
  templateLocalOnly: boolean;
  quickStart: boolean;
}

/** True when the wizard will collect provider keys (cloud, non-local template). */
function isCloud(backend: BackendMode, templateLocalOnly: boolean): boolean {
  return backend === "cloud" && !templateLocalOnly;
}

/** The next step from `from`, skipping provider/key steps for non-cloud backends. */
export function nextStep(from: Step, opts: Pick<FlowOpts, "backend" | "templateLocalOnly">): Step {
  const flow: Record<Step, Step> = {
    welcome: "template",
    template: opts.templateLocalOnly ? "limits" : "backend",
    backend: opts.backend === "cloud" ? "providers" : "limits",
    providers: "keys",
    keys: "limits",
    limits: "review",
    review: "done",
    done: "done",
  };
  return flow[from];
}

/** The previous step from `from` (quick-start jumps review → welcome). */
export function backStep(from: Step, opts: FlowOpts): Step {
  if (from === "review" && opts.quickStart) return "welcome";
  const useCloud = isCloud(opts.backend, opts.templateLocalOnly);
  const flow: Record<Step, Step> = {
    welcome: "welcome",
    template: "welcome",
    backend: "template",
    providers: "backend",
    keys: "providers",
    limits: useCloud ? "keys" : opts.templateLocalOnly ? "template" : "backend",
    review: "limits",
    done: "review",
  };
  return flow[from];
}
