import { CopyButton } from "../CopyButton";

type TestStatus = "idle" | "checking" | "ok" | "error";

/** Final wizard step: confirm setup, auto-verify with a test chat, and link out
 *  to the dashboard. `onTest` re-runs the chat; the wizard auto-runs it once on
 *  arrival so the operator sees a reply without clicking. */
export function DoneStep({
  useCloud,
  useLocal,
  nextCommand,
  hybridGuidance,
  testStatus,
  testReply,
  error,
  onTest,
  onOpenDashboard,
}: {
  useCloud: boolean;
  useLocal: boolean;
  nextCommand?: string;
  hybridGuidance?: string;
  testStatus: TestStatus;
  testReply: string;
  error: string;
  onTest: () => void;
  onOpenDashboard: () => void;
}) {
  return (
    <section className="setup-step">
      <h1 className="setup-success-title">You&apos;re all set</h1>
      <p className="setup-lead">
        Configuration is saved and active. {useLocal ? "One more step below, then " : ""}try a
        test message to confirm everything works.
      </p>

      {nextCommand && (
        <div className="setup-terminal-card">
          <h2>{useLocal ? "Start local models" : "Connect real providers"}</h2>
          <p>
            {useLocal
              ? "Run this in your project folder (requires Ollama installed):"
              : "Run this once in your project folder so the model proxy loads your API keys:"}
          </p>
          <div className="setup-terminal-row">
            <pre className="setup-terminal">{nextCommand}</pre>
            <CopyButton text={nextCommand} className="setup-btn-secondary setup-copy-btn" />
          </div>
          <p className="setup-field-help">
            Wait until services are healthy — we&apos;ll check for you below.
          </p>
        </div>
      )}

      {useCloud && !nextCommand && (
        <div className="setup-callout setup-callout-success">
          Your provider keys are live. The model proxy was restarted automatically.
          {hybridGuidance && <> {hybridGuidance}</>}
        </div>
      )}

      {!useCloud && !useLocal && (
        <div className="setup-callout setup-callout-success">
          Demo mode is live — no terminal commands needed. Send a test message now.
        </div>
      )}

      <div className="setup-test-block">
        <div className="setup-test-head">
          <button
            type="button"
            className="setup-btn-secondary"
            onClick={onTest}
            disabled={testStatus === "checking"}
          >
            {testStatus === "checking" ? "Checking…" : "Test again"}
          </button>
          {testStatus === "checking" && (
            <span className="setup-test-status" aria-live="polite">
              Checking that AI responds…
            </span>
          )}
          {testStatus === "ok" && (
            <span className="setup-test-status setup-test-status-ok" aria-live="polite">
              ✓ AI responded
            </span>
          )}
        </div>
        {testReply && (
          <div className="setup-test-reply">
            <span className="setup-test-label">AI replied:</span>
            <p>{testReply}</p>
          </div>
        )}
      </div>
      {error && testStatus === "error" && <p className="setup-error">{error}</p>}
      <div className="setup-actions setup-actions-end">
        <button type="button" className="setup-btn-primary" onClick={onOpenDashboard}>
          Open dashboard
        </button>
      </div>
    </section>
  );
}
