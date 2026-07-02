import { Navigate, Route, Routes, Link, useLocation } from "react-router-dom";
import { getToken } from "./api/client";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RequestsPage } from "./pages/RequestsPage";
import { UsagePage } from "./pages/UsagePage";
import { KeysPage } from "./pages/KeysPage";
import { PolicyPage } from "./pages/PolicyPage";
import { HealthPage } from "./pages/HealthPage";

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const nav = [
    ["/overview", "Overview"],
    ["/requests", "Requests"],
    ["/usage", "Usage"],
    ["/keys", "Keys"],
    ["/policy", "Policy"],
    ["/health", "Health"],
  ] as const;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Ai-Guard Console</div>
        <nav>
          {nav.map(([path, label]) => (
            <Link key={path} to={path} className={loc.pathname === path ? "active" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        <p className="hint">Metadata only — no prompt content unless capture is enabled server-side.</p>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<RequireAuth><OverviewPage /></RequireAuth>} />
      <Route path="/requests" element={<RequireAuth><RequestsPage /></RequireAuth>} />
      <Route path="/usage" element={<RequireAuth><UsagePage /></RequireAuth>} />
      <Route path="/keys" element={<RequireAuth><KeysPage /></RequireAuth>} />
      <Route path="/policy" element={<RequireAuth><PolicyPage /></RequireAuth>} />
      <Route path="/health" element={<RequireAuth><HealthPage /></RequireAuth>} />
    </Routes>
  );
}
