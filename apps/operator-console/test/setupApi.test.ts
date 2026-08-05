import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";

// Mock only apiFetch; ApiError stays real so the wrapper's `instanceof` status
// checks are exercised rather than stubbed away.
const apiFetch = vi.fn();
vi.mock("../src/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/client")>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { fetchSetupStatus, mergeSetupPolicy, saveSetupSecrets } = await import("../src/api/setup");

afterEach(() => {
  apiFetch.mockReset();
});

// The failure branches here decide whether a returning operator gets forced back
// through the wizard. Forcing it against an already-configured gateway clobbers a
// live policy, so "when in doubt, don't show the wizard" is the required posture.
describe("fetchSetupStatus", () => {
  it("passes the server's answer through when the call succeeds", async () => {
    apiFetch.mockResolvedValue({ enabled: true, configured: false });
    expect(await fetchSetupStatus()).toEqual({ enabled: true, configured: false });
    expect(apiFetch).toHaveBeenCalledWith("/v1/setup/status");
  });

  it("reports the setup API disabled on 404 (production console)", async () => {
    apiFetch.mockRejectedValue(new ApiError(404, "not found"));
    expect(await fetchSetupStatus()).toEqual({ enabled: false, configured: false });
  });

  it("fails safe on a transient error — never forces the wizard", async () => {
    // configured:true is the load-bearing half: enabled:false alone would still
    // let a caller that only checks `configured` reopen the wizard.
    apiFetch.mockRejectedValue(new ApiError(503, "unavailable"));
    expect(await fetchSetupStatus()).toEqual({ enabled: false, configured: true });
  });

  it("fails safe on a non-ApiError rejection too (network down)", async () => {
    apiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await fetchSetupStatus()).toEqual({ enabled: false, configured: true });
  });

  it("does not treat a 404-like message on another status as 404", async () => {
    apiFetch.mockRejectedValue(new ApiError(500, "404 not found"));
    expect(await fetchSetupStatus()).toEqual({ enabled: false, configured: true });
  });
});

describe("saveSetupSecrets", () => {
  it("POSTs the secrets, cloud flag, and generated LiteLLM config together", async () => {
    apiFetch.mockResolvedValue({ ok: true, savedKeys: ["OPENAI_API_KEY"], message: "saved" });
    const res = await saveSetupSecrets(
      { OPENAI_API_KEY: "sk-real" },
      { useCloud: true, litellmYaml: "model_list: []\n" },
    );
    expect(res.savedKeys).toEqual(["OPENAI_API_KEY"]);

    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe("/v1/setup/secrets");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      secrets: { OPENAI_API_KEY: "sk-real" },
      useCloud: true,
      litellmYaml: "model_list: []\n",
    });
  });

  it("omits litellmYaml when there is no config to install", async () => {
    apiFetch.mockResolvedValue({ ok: true, savedKeys: [], message: "saved" });
    await saveSetupSecrets({}, { useCloud: false });
    const body = JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string) as object;
    expect("litellmYaml" in body).toBe(false);
    expect((body as { useCloud: boolean }).useCloud).toBe(false);
  });

  it("propagates a rejection so the wizard can show the real reason", async () => {
    apiFetch.mockRejectedValue(new ApiError(403, "Setup requires policy:write"));
    await expect(saveSetupSecrets({}, { useCloud: true })).rejects.toThrow(/policy:write/);
  });
});

describe("mergeSetupPolicy", () => {
  it("returns the merged YAML from the server", async () => {
    apiFetch.mockResolvedValue({ yaml: "features: {}\nbilling: {}\n" });
    expect(await mergeSetupPolicy("features: {}\n")).toBe("features: {}\nbilling: {}\n");
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe("/v1/setup/policy/merge");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ yaml: "features: {}\n" });
  });

  it("propagates failures instead of silently returning the unmerged YAML", async () => {
    // Swallowing this would drop boot-only fields (pricing, retry, billing) from
    // the stored policy while the gateway keeps running with them.
    apiFetch.mockRejectedValue(new ApiError(500, "merge failed"));
    await expect(mergeSetupPolicy("features: {}\n")).rejects.toThrow("merge failed");
  });
});
