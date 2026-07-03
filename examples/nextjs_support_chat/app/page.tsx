export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>Next.js + Modelgov</h1>
      <p>
        This page is a shell. Use the API route:
      </p>
      <pre style={{ background: "#f4f4f4", padding: "1rem" }}>
        {`curl -X POST http://localhost:3001/api/support \\
  -H 'content-type: application/json' \\
  -H 'cookie: demo_session=logged_in' \\
  -d '{"message":"How do I reset my password?"}'`}
      </pre>
      <p>
        See <code>README.md</code> for the auth → Modelgov integration pattern.
      </p>
    </main>
  );
}
