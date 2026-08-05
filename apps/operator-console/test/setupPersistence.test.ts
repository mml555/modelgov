import { afterEach, describe, expect, it } from "vitest";
import {
  isSetupComplete,
  loadWizardState,
  markSetupComplete,
  safeRestoredStep,
  saveWizardState,
  type PersistedWizard,
} from "../src/setup/persistence";

// The suite runs in the node environment (no DOM), so Web Storage is installed
// per-test. That is not a workaround — "storage is absent or throws" is a real
// browser state (private mode, disabled cookies, quota) that these functions
// promise to survive, and it is the default here rather than a special case.

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const throwingStorage = {
  getItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
  removeItem() {
    throw new Error("storage disabled");
  },
};

function installStorage(local: unknown, session: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
}

function installMemoryStorage() {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  installStorage(local, session);
  return { local, session };
}

afterEach(() => {
  // Leave no global behind for the next file (fileParallelism is off, so these
  // would otherwise leak across the run).
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

const WIZARD: PersistedWizard = {
  step: "limits",
  templateId: "support_chat",
  backend: "cloud",
  providers: ["openai"],
  safety: "balanced",
  monthlyBudget: 200,
  customBudget: false,
  quickStart: false,
};

describe("isSetupComplete / markSetupComplete", () => {
  it("is false before setup and true after marking it", () => {
    installMemoryStorage();
    expect(isSetupComplete()).toBe(false);
    markSetupComplete();
    expect(isSetupComplete()).toBe(true);
  });

  it("only treats the exact '1' sentinel as complete", () => {
    const { local } = installMemoryStorage();
    local.setItem("modelgov-setup-v1-complete", "true");
    expect(isSetupComplete()).toBe(false);
  });

  it("drops in-progress wizard state once setup completes", () => {
    installMemoryStorage();
    saveWizardState(WIZARD);
    expect(loadWizardState()).toEqual(WIZARD);
    markSetupComplete();
    expect(loadWizardState()).toEqual({});
  });

  it("reports not-complete when storage throws (private mode), never crashes", () => {
    installStorage(throwingStorage, throwingStorage);
    expect(isSetupComplete()).toBe(false);
    expect(() => markSetupComplete()).not.toThrow();
  });

  it("reports not-complete when storage is absent entirely", () => {
    expect(isSetupComplete()).toBe(false);
    expect(() => markSetupComplete()).not.toThrow();
  });
});

describe("loadWizardState / saveWizardState", () => {
  it("round-trips the non-secret selections", () => {
    installMemoryStorage();
    saveWizardState(WIZARD);
    expect(loadWizardState()).toEqual(WIZARD);
  });

  it("returns {} when nothing was saved", () => {
    installMemoryStorage();
    expect(loadWizardState()).toEqual({});
  });

  it("returns {} on corrupt JSON instead of throwing", () => {
    const { session } = installMemoryStorage();
    session.setItem("modelgov-setup-wizard-state-v1", "{not json");
    expect(loadWizardState()).toEqual({});
  });

  it("survives storage that throws on read and on write", () => {
    installStorage(throwingStorage, throwingStorage);
    expect(loadWizardState()).toEqual({});
    expect(() => saveWizardState(WIZARD)).not.toThrow();
  });

  it("persists to SESSION storage, not local (wizard progress is per-tab)", () => {
    const { local, session } = installMemoryStorage();
    saveWizardState(WIZARD);
    expect(session.getItem("modelgov-setup-wizard-state-v1")).toBeTruthy();
    expect(local.getItem("modelgov-setup-wizard-state-v1")).toBeNull();
  });

  it("never writes a secret — only the declared selection fields", () => {
    const { session } = installMemoryStorage();
    saveWizardState(WIZARD);
    const raw = session.getItem("modelgov-setup-wizard-state-v1") ?? "";
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(
      Object.keys(WIZARD).sort(),
    );
  });
});

describe("safeRestoredStep", () => {
  it("restores a saved step that still applies", () => {
    expect(safeRestoredStep({ step: "limits", backend: "cloud" })).toBe("limits");
    expect(safeRestoredStep({ step: "keys", backend: "cloud" })).toBe("keys");
    expect(safeRestoredStep({ step: "providers", backend: "cloud" })).toBe("providers");
  });

  it("starts over when nothing was saved", () => {
    expect(safeRestoredStep({})).toBe("welcome");
  });

  it("never restores into 'done' (that would hide the wizard)", () => {
    expect(safeRestoredStep({ step: "done", backend: "cloud" })).toBe("welcome");
  });

  it("does not reopen provider/key steps for a non-cloud backend", () => {
    // Stranding case: the saved step asks for an API key, but the restored
    // backend has no keys to enter.
    expect(safeRestoredStep({ step: "providers", backend: "demo" })).toBe("welcome");
    expect(safeRestoredStep({ step: "keys", backend: "local" })).toBe("welcome");
    expect(safeRestoredStep({ step: "keys", backend: undefined })).toBe("welcome");
  });

  it("keeps backend-independent steps regardless of backend", () => {
    expect(safeRestoredStep({ step: "limits", backend: "demo" })).toBe("limits");
    expect(safeRestoredStep({ step: "template", backend: "local" })).toBe("template");
  });
});
