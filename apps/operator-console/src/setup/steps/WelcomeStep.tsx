/** First wizard step: explain Modelgov + offer the recommended real-provider
 *  quick-start, with a demo escape hatch for people who only want to look. */
export function WelcomeStep({
  onQuickStart,
  onCustomize,
  onTryDemo,
}: {
  onQuickStart: () => void;
  onCustomize: () => void;
  onTryDemo: () => void;
}) {
  return (
    <section className="setup-step">
      <h1>Welcome</h1>
      <p className="setup-lead">
        Modelgov sits between your app and AI providers. It enforces spending limits, safety
        rules, and who can use which models — so one misconfigured feature cannot drain your
        budget.
      </p>
      <div className="setup-info-grid">
        <div className="setup-info-tile">
          <h3>What you will choose</h3>
          <ul>
            <li>What your product does (support chat, SaaS tiers, etc.)</li>
            <li>Which AI provider to connect (OpenAI, Anthropic, Azure, …)</li>
            <li>Monthly spend cap and safety level</li>
          </ul>
        </div>
        <div className="setup-info-tile">
          <h3>What you do not need</h3>
          <ul>
            <li>Editing YAML or config files by hand</li>
            <li>Understanding LiteLLM or gateway internals</li>
            <li>A key just to look around — a built-in demo runs with no account</li>
          </ul>
        </div>
      </div>
      <div className="setup-quickstart-card">
        <div className="setup-quickstart-head">
          <span className="setup-badge setup-badge-accent">Recommended</span>
          <h2>Quick start — connect your AI in a couple of minutes</h2>
        </div>
        <p>
          Sensible defaults for a real setup: OpenAI, a customer-support-chat template, balanced
          safety, and a $200/month spend cap — so budgets and cost tracking are real from the
          first request. You just paste your OpenAI API key; change anything later.
        </p>
        <ul className="setup-quickstart-list">
          <li>OpenAI — paste one API key (swap providers anytime)</li>
          <li>Support chat — typical starter rules for a help widget</li>
          <li>Balanced safety — masks personal data in logs</li>
          <li>$200/month spend cap — real cost governance from request one</li>
        </ul>
        <button type="button" className="setup-btn-primary" onClick={onQuickStart}>
          Use recommended settings
        </button>
      </div>
      <div className="setup-actions setup-actions-split">
        <button type="button" className="setup-btn-secondary" onClick={onCustomize}>
          Customize step by step
        </button>
        <button type="button" className="setup-link-btn" onClick={onTryDemo}>
          Just exploring? Try the demo (no API key) →
        </button>
      </div>
    </section>
  );
}
