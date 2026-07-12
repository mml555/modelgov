import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { renderModelgovYaml, modelStringsFor, type Provider } from "create-modelgov/render";
import { renderLitellmConfig } from "create-modelgov/litellm";
import { TEMPLATES, type TemplateId } from "create-modelgov/templates";
import { activateVersion, previewPolicy, saveVersion } from "../api/policy";
import { mergeSetupPolicy, saveSetupSecrets } from "../api/setup";
import { apiBase, apiFetch, ApiError } from "../api/client";
import {
  BACKEND_OPTIONS,
  BEGINNER_PRESET,
  BUDGET_PRESETS,
  HYBRID_INJECTION_GUIDANCE,
  PROVIDER_GROUPS,
  SAFETY_OPTIONS,
  shouldShowHybridInjectionGuidance,
  TEMPLATE_CHOICES,
  type BackendMode,
  credentialFieldsForProviders,
  providerSummary,
} from "../setup/catalog";
import { ProviderLogo } from "../setup/ProviderLogo";
import { SetupNav } from "../setup/SetupNav";
import { WelcomeStep } from "../setup/steps/WelcomeStep";
import { DoneStep } from "../setup/steps/DoneStep";
import { keyFormatWarning, parseSetupError } from "../setup/validation";
import { stepIndex, getVisibleSteps, nextStep, backStep, type Step } from "../setup/flow";
import {
  loadWizardState,
  markSetupComplete,
  safeRestoredStep,
  saveWizardState,
} from "../setup/persistence";

export function SetupWizardPage() {
  const nav = useNavigate();
  const [persisted] = useState(loadWizardState);
  const [step, setStep] = useState<Step>(() => safeRestoredStep(persisted));
  const [templateId, setTemplateId] = useState<TemplateId>(persisted.templateId ?? "support_chat");
  const [backend, setBackend] = useState<BackendMode>(persisted.backend ?? "demo");
  const [providers, setProviders] = useState<Provider[]>(persisted.providers ?? ["openai"]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [safety, setSafety] = useState<"dev" | "balanced" | "strict">(persisted.safety ?? "balanced");
  const [monthlyBudget, setMonthlyBudget] = useState(persisted.monthlyBudget ?? 500);
  const [customBudget, setCustomBudget] = useState(persisted.customBudget ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nextCommand, setNextCommand] = useState<string | undefined>();
  const [testReply, setTestReply] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [quickStart, setQuickStart] = useState(persisted.quickStart ?? false);
  const autoTestedRef = useRef(false);

  // Persist non-secret selections so an accidental refresh keeps progress.
  useEffect(() => {
    saveWizardState({ step, templateId, backend, providers, safety, monthlyBudget, customBudget, quickStart });
  }, [step, templateId, backend, providers, safety, monthlyBudget, customBudget, quickStart]);

  const template = TEMPLATES[templateId];
  const templateLocalOnly = template.localOnly === true;
  const useCloud = backend === "cloud" && !templateLocalOnly;
  const useLocal = backend === "local" || templateLocalOnly;
  const hybridInjection = useCloud && safety !== "dev";
  const showHybridInjectionGuidance = shouldShowHybridInjectionGuidance({
    useCloud,
    safety,
    providers,
  });

  const credentialFields = useMemo(
    () => credentialFieldsForProviders(providers),
    [providers],
  );

  const progressSteps = getVisibleSteps(backend, templateLocalOnly);
  const currentProgress = stepIndex(step);

  function toggleProvider(p: Provider) {
    setProviders((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function startBeginnerPath() {
    setTemplateId(BEGINNER_PRESET.templateId);
    setBackend(BEGINNER_PRESET.backend);
    setSafety(BEGINNER_PRESET.safety);
    setMonthlyBudget(BEGINNER_PRESET.monthlyBudget);
    setCustomBudget(false);
    setProviders(["openai"]);
    setSecrets({});
    setQuickStart(true);
    setError("");
    // Recommended path is a real provider (OpenAI preset), so the only thing left
    // is the key — drop the operator on the keys step rather than review.
    setStep("keys");
  }

  // Secondary "just exploring" path: demo AI needs no key, so it can jump
  // straight to review. Budgets/cost tracking won't be meaningful here.
  function startDemoPath() {
    setTemplateId("support_chat");
    setBackend("demo");
    setSafety("balanced");
    setMonthlyBudget(200);
    setCustomBudget(false);
    setProviders(["openai"]);
    setSecrets({});
    setQuickStart(true);
    setError("");
    setStep("review");
  }

  function selectBackend(mode: BackendMode) {
    setBackend(mode);
    if (mode === "local") setTemplateId("local_dev");
    if (mode === "demo" && templateLocalOnly) setTemplateId("support_chat");
  }

  function goNext(from: Step) {
    if (from === "welcome") setQuickStart(false);
    setStep(nextStep(from, { backend, templateLocalOnly }));
    setError("");
  }

  function goBack(from: Step) {
    setStep(backStep(from, { backend, templateLocalOnly, quickStart }));
    setError("");
  }

  async function applySetup() {
    setBusy(true);
    setError("");
    try {
      const effectiveTemplate = useLocal ? TEMPLATES.local_dev : template;

      const generated = renderModelgovYaml({
        projectName: "my-app",
        template: effectiveTemplate,
        providers: useCloud ? providers : ["openai"],
        mode: "simple",
        safetyPreset: useLocal ? "dev" : safety,
        monthlyBudgetUsd: monthlyBudget,
        hybridInjection,
      });

      // Preserve the running gateway's boot-only fields (routing.retry, pricing,
      // injection model, billing) so the stored policy matches what's actually
      // active — otherwise the wizard's slim config would silently drop them.
      const yaml = await mergeSetupPolicy(generated);

      const preview = await previewPolicy(yaml);
      if (!preview.valid) throw new Error(preview.error ?? "Policy validation failed");

      const saved = await saveVersion(yaml, "Initial setup wizard");

      // Persist provider secrets + LiteLLM config BEFORE activating the policy, so
      // a failed secret save can't leave a policy active that points at providers
      // with no credentials. Activation is the last, committing step.
      if (useCloud) {
        const scaffoldOpts = {
          projectName: "my-app",
          template: effectiveTemplate,
          providers,
          mode: "simple" as const,
          safetyPreset: safety,
          monthlyBudgetUsd: monthlyBudget,
          hybridInjection,
        };
        const litellmYaml = renderLitellmConfig(modelStringsFor(scaffoldOpts), { hybridInjection });
        const result = await saveSetupSecrets(secrets, { useCloud: true, litellmYaml });
        setNextCommand(result.nextCommand);
      } else if (useLocal) {
        setNextCommand("make start-local");
      }

      await activateVersion(saved.id);

      markSetupComplete();
      setStep("done");
    } catch (e) {
      const msg = parseSetupError(e);
      if (msg.includes("requires_restart") || msg.includes("boot-only")) {
        setError(
          "This configuration needs a gateway restart to apply fully. Run `docker compose -f docker-compose.simple.yml restart api`, wait for it to be healthy, then click Apply again.",
        );
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendTest({ retries = 0 }: { retries?: number } = {}) {
    setError("");
    setTestReply("");
    setTestStatus("checking");
    const t = useLocal ? TEMPLATES.local_dev : template;
    // After a cloud/local key save the model proxy may still be restarting/warming
    // up, so retry a few times before declaring failure — the happy path succeeds
    // on the first try.
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await apiFetch<{ message?: { content?: string } }>("/v1/chat", {
          method: "POST",
          body: JSON.stringify({
            userId: "setup-test",
            userType: t.exampleUserType,
            feature: t.primaryFeature,
            modelClass: useLocal ? "local" : "cheap",
            messages: [{ role: "user", content: t.examplePrompt }],
          }),
        });
        setTestReply(res.message?.content ?? "(no content)");
        setTestStatus("ok");
        return;
      } catch (e) {
        // A plain Error means `fetch` itself rejected (proxy not up yet); an
        // ApiError means the gateway RESPONDED — so a 503 is still warming up, but
        // any other status is a real error (bad key, quota, model-not-found) that
        // retrying will not fix. Surface those verbatim instead of masking them.
        const transient = !(e instanceof ApiError) || e.status === 503;
        if (transient && attempt < retries) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        setTestStatus("error");
        if (e instanceof ApiError && !transient) {
          setError(e.code ? `${e.message} (${e.code})` : e.message);
        } else {
          setError(
            "The model proxy isn't responding yet. Give it a few seconds and click “Test again”.",
          );
        }
        return;
      }
    }
  }

  // On reaching the final step, auto-run one test so a non-technical operator
  // sees the AI reply without clicking anything. Cloud/local get warmup retries
  // (the proxy may be restarting); demo is instant.
  useEffect(() => {
    if (step !== "done" || autoTestedRef.current) return;
    autoTestedRef.current = true;
    void sendTest({ retries: useCloud || useLocal ? 4 : 0 });
  }, [step]);

  return (
    <div className="setup-wizard">
      <div className="setup-shell">
        <header className="setup-header">
          <div className="setup-brand">
            <img src="/modelgov-logo.png" alt="" className="setup-brand-logo" width={40} height={40} />
            <div>
              <img src="/modelgov-wordmark.png" alt="Modelgov" className="setup-brand-wordmark" height={22} />
              <p>Configure AI for your app in a few minutes — no YAML required.</p>
            </div>
          </div>
        </header>

        {step !== "welcome" && step !== "done" && (
          <nav className="setup-progress" aria-label="Setup progress">
            {progressSteps
              .filter((s) => s.id !== "welcome" && s.id !== "done")
              .map((s) => {
                const idx = stepIndex(s.id);
                const active = s.id === step;
                const done = idx < currentProgress;
                return (
                  <div
                    key={s.id}
                    className={`setup-progress-step${active ? " active" : ""}${done ? " done" : ""}`}
                    aria-current={active ? "step" : undefined}
                  >
                    <span className="setup-progress-dot" />
                    <span className="setup-progress-label">{s.label}</span>
                  </div>
                );
              })}
          </nav>
        )}

        <main className="setup-card">
          {step === "welcome" && (
            <WelcomeStep
              onQuickStart={startBeginnerPath}
              onCustomize={() => goNext("welcome")}
              onTryDemo={startDemoPath}
            />
          )}

          {step === "template" && (
            <section className="setup-step">
              <h1>What is your app doing with AI?</h1>
              <p className="setup-lead">
                This picks starter rules (who gets which models, daily limits). You can change
                everything later in the dashboard.
              </p>
              <div className="setup-choice-grid">
                {TEMPLATE_CHOICES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`setup-choice-card${templateId === t.id ? " selected" : ""}`}
                    onClick={() => {
                      setTemplateId(t.id);
                      if (t.localOnly) setBackend("local");
                    }}
                  >
                    <span className="setup-choice-title">{t.title}</span>
                    <span className="setup-choice-desc">{t.description}</span>
                    {t.recommended && <span className="setup-badge setup-badge-accent">Recommended</span>}
                    {t.localOnly && <span className="setup-badge">Local Ollama</span>}
                  </button>
                ))}
              </div>
              <SetupNav onBack={() => goBack("template")} onNext={() => goNext("template")} />
            </section>
          )}

          {step === "backend" && (
            <section className="setup-step">
              <h1>Where should AI requests go?</h1>
              <p className="setup-lead">
                Modelgov supports 14+ providers (OpenAI, Anthropic, Google, Azure, AWS Bedrock,
                Vertex, Groq, Mistral, OpenRouter, GitHub Copilot, and more). Pick how you want to
                start — you can add providers later.
              </p>
              <div className="setup-choice-grid setup-choice-grid-single">
                {BACKEND_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`setup-choice-card setup-choice-card-wide${backend === opt.id ? " selected" : ""}`}
                    onClick={() => selectBackend(opt.id)}
                  >
                    <div className="setup-choice-card-head">
                      <span className="setup-choice-title">{opt.title}</span>
                      {opt.badge && <span className="setup-badge setup-badge-accent">{opt.badge}</span>}
                    </div>
                    <span className="setup-choice-desc">{opt.description}</span>
                  </button>
                ))}
              </div>
              {backend === "cloud" && (
                <p className="setup-callout">
                  Next you will pick which providers to enable. Each needs credentials from that
                  provider&apos;s website — we show exactly where to find them.
                </p>
              )}
              <SetupNav onBack={() => goBack("backend")} onNext={() => goNext("backend")} />
            </section>
          )}

          {step === "providers" && (
            <section className="setup-step">
              <h1>Which AI providers do you use?</h1>
              <p className="setup-lead">
                Select every provider you want available. You only need keys for the ones you check.
                Not sure? Start with one (e.g. OpenAI) — you can add more anytime.
              </p>
              {PROVIDER_GROUPS.map((group) => (
                <div key={group.id} className="setup-provider-group">
                  <div className="setup-provider-group-head">
                    <h2>{group.title}</h2>
                    <p>{group.description}</p>
                  </div>
                  <div className="setup-provider-grid">
                    {group.providers.map((p) => {
                      const spec = PROVIDER_REGISTRY[p];
                      const selected = providers.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          className={`setup-provider-chip${selected ? " selected" : ""}`}
                          onClick={() => toggleProvider(p)}
                          aria-pressed={selected}
                        >
                          <ProviderLogo slug={p} label={spec?.label ?? p} size={18} />
                          <span className="setup-provider-name">{spec?.label ?? p}</span>
                          {spec?.billingKind === "subscription" && (
                            <span className="setup-provider-tag">Subscription</span>
                          )}
                          {spec?.authKind === "aws" && (
                            <span className="setup-provider-tag">AWS IAM</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {providers.length === 0 && (
                <p className="setup-hint-warn">Select at least one provider to continue.</p>
              )}
              <SetupNav
                onBack={() => goBack("providers")}
                onNext={() => goNext("providers")}
                nextDisabled={providers.length === 0}
              />
            </section>
          )}

          {step === "keys" && (
            <section className="setup-step">
              <h1>Paste your provider credentials</h1>
              <p className="setup-lead">
                These are saved to the <code>.env</code> file on your machine only — not sent to
                Modelgov&apos;s servers. They are used locally to call the provider on your behalf.
              </p>
              <div className="setup-credentials">
                {credentialFields.map((f) => (
                  <div key={f.key} className="setup-field">
                    <label htmlFor={`cred-${f.key}`}>
                      <span className="setup-field-label-row">
                        <ProviderLogo slug={f.provider} label={f.providerLabel} size={18} />
                        <span className="setup-field-label">{f.label}</span>
                      </span>
                      <span className="setup-field-provider">for {f.providerLabel}</span>
                    </label>
                    <input
                      id={`cred-${f.key}`}
                      type={f.key.includes("SECRET") || f.key.includes("KEY") || f.key.includes("TOKEN") ? "password" : "text"}
                      value={secrets[f.key] ?? ""}
                      placeholder={f.placeholder}
                      onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                      autoComplete="off"
                    />
                    <p className="setup-field-help">{f.help}</p>
                    {f.optional && <p className="setup-field-optional">Optional</p>}
                    {keyFormatWarning(f.key, secrets[f.key] ?? "") && (
                      <p className="setup-field-warn" role="status">
                        {keyFormatWarning(f.key, secrets[f.key] ?? "")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {showHybridInjectionGuidance && (
                <p className="setup-callout">
                  <strong>{HYBRID_INJECTION_GUIDANCE.title}.</strong>{" "}
                  {HYBRID_INJECTION_GUIDANCE.summary}{" "}
                  {HYBRID_INJECTION_GUIDANCE.detail}
                </p>
              )}
              <p className="setup-callout">
                Clicking Apply will save these keys and switch the local stack to your real provider
                automatically.
              </p>
              <SetupNav onBack={() => goBack("keys")} onNext={() => goNext("keys")} />
            </section>
          )}

          {step === "limits" && (
            <section className="setup-step">
              <h1>Spending cap &amp; safety</h1>
              <p className="setup-lead">
                Modelgov blocks requests when you hit these limits — protecting you from runaway
                costs or unsafe content.
              </p>

              {!useLocal && (
                <>
                  <h2 className="setup-subhead">Safety rules</h2>
                  <div className="setup-choice-grid">
                    {SAFETY_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`setup-choice-card${safety === opt.id ? " selected" : ""}`}
                        onClick={() => setSafety(opt.id)}
                      >
                        <span className="setup-choice-title">{opt.title}</span>
                        <span className="setup-choice-desc">{opt.description}</span>
                      </button>
                    ))}
                  </div>
                  {showHybridInjectionGuidance && (
                    <p className="setup-callout">
                      <strong>{HYBRID_INJECTION_GUIDANCE.title}.</strong>{" "}
                      {HYBRID_INJECTION_GUIDANCE.summary}{" "}
                      {HYBRID_INJECTION_GUIDANCE.detail}
                    </p>
                  )}
                </>
              )}

              {useLocal && (
                <p className="setup-callout">
                  Local Ollama mode uses development safety (no blocking). Spend caps still apply
                  for consistency.
                </p>
              )}

              <h2 className="setup-subhead">Monthly spend cap (all users combined)</h2>
              <div className="setup-budget-chips">
                {BUDGET_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`setup-budget-chip${!customBudget && monthlyBudget === p.value ? " selected" : ""}`}
                    onClick={() => {
                      setCustomBudget(false);
                      setMonthlyBudget(p.value);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`setup-budget-chip${customBudget ? " selected" : ""}`}
                  onClick={() => setCustomBudget(true)}
                >
                  Custom
                </button>
              </div>
              {customBudget && (
                <div className="setup-field setup-field-inline">
                  <label htmlFor="budget-custom">Custom monthly cap (USD)</label>
                  <input
                    id="budget-custom"
                    type="number"
                    min={1}
                    value={monthlyBudget}
                    onChange={(e) => setMonthlyBudget(Number(e.target.value))}
                  />
                </div>
              )}

              <SetupNav onBack={() => goBack("limits")} onNext={() => goNext("limits")} />
            </section>
          )}

          {step === "review" && (
            <section className="setup-step">
              <h1>Review &amp; apply</h1>
              <p className="setup-lead">
                {quickStart
                  ? "These are the recommended beginner settings. Change anything later in the dashboard."
                  : "Here is what we will configure. Click apply when ready."}
              </p>
              <dl className="setup-review">
                <div className="setup-review-row">
                  <dt>Use case</dt>
                  <dd>{TEMPLATES[useLocal ? "local_dev" : templateId].label.split("—")[0]?.trim()}</dd>
                </div>
                <div className="setup-review-row">
                  <dt>AI source</dt>
                  <dd>
                    {useCloud
                      ? providerSummary(providers)
                      : useLocal
                        ? "Local Ollama on this computer"
                        : "Built-in demo (no API keys)"}
                  </dd>
                </div>
                <div className="setup-review-row">
                  <dt>Safety</dt>
                  <dd>{useLocal ? "Development (off)" : SAFETY_OPTIONS.find((s) => s.id === safety)?.title}</dd>
                </div>
                {showHybridInjectionGuidance && (
                  <div className="setup-review-row">
                    <dt>Injection screening</dt>
                    <dd>Hybrid (demo model locally — saves free-tier quota)</dd>
                  </div>
                )}
                <div className="setup-review-row">
                  <dt>Monthly spend cap</dt>
                  <dd>${monthlyBudget.toLocaleString()} USD</dd>
                </div>
                <div className="setup-review-row">
                  <dt>Gateway URL</dt>
                  <dd><code>{apiBase()}</code></dd>
                </div>
              </dl>
              {error && <p className="setup-error">{error}</p>}
              <SetupNav
                onBack={() => goBack("review")}
                onNext={() => void applySetup()}
                nextLabel={busy ? "Applying…" : "Apply configuration"}
                nextDisabled={busy}
              />
            </section>
          )}

          {step === "done" && (
            <DoneStep
              useCloud={useCloud}
              useLocal={useLocal}
              nextCommand={nextCommand}
              hybridGuidance={showHybridInjectionGuidance ? HYBRID_INJECTION_GUIDANCE.detail : undefined}
              testStatus={testStatus}
              testReply={testReply}
              error={error}
              onTest={() => void sendTest({ retries: useCloud || useLocal ? 4 : 0 })}
              onOpenDashboard={() => nav("/overview")}
            />
          )}
        </main>
      </div>
    </div>
  );
}

