export const metadata = {
  title: "Ai-Guard Chatbot Demo",
  description: "A chatbot where every message is checked by Ai-Guard before the model runs.",
};

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: #0b1020; color: #e6e8ef; }
  a { color: #8ab4ff; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 20px 16px 40px; }
  .card { background: #141a2e; border: 1px solid #26304d; border-radius: 12px; }
  .muted { color: #9aa3b8; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #2c3860; }
  .badge.allow { color: #7ee2a8; border-color: #235c3f; background: #10241a; }
  .badge.degrade { color: #ffd27a; border-color: #6b5320; background: #241d10; }
  .badge.fallback { color: #9ecbff; border-color: #274a73; background: #10203a; }
  .badge.block { color: #ff9a9a; border-color: #6b2626; background: #241010; }
  button { cursor: pointer; }
  input, select, textarea { font: inherit; }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
