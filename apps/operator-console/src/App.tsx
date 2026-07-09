import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, Link, useLocation } from "react-router-dom";
import { getToken, getTenant, setTenant as persistTenant } from "./api/client";
import { fetchTenants, fetchWhoami, type Whoami } from "./api/whoami";
import { WhoamiContext, usePermissions } from "./whoami-context";
import { visibleNav } from "./permissions";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RequestsPage } from "./pages/RequestsPage";
import { UsagePage } from "./pages/UsagePage";
import { KeysPage } from "./pages/KeysPage";
import { PolicyPage } from "./pages/PolicyPage";
import { AuditPage } from "./pages/AuditPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { MetricsPage } from "./pages/MetricsPage";
import { HealthPage } from "./pages/HealthPage";
import { SetupWizardPage, isSetupComplete } from "./pages/SetupWizardPage";

interface TenantSwitcher {
  tenants: string[];
  selected: string;
  onChange: (t: string) => void;
}

function Shell({ children, tenantSwitcher }: { children: React.ReactNode; tenantSwitcher?: TenantSwitcher }) {
  const loc = useLocation();
  const perms = usePermissions();
  const nav = visibleNav(perms);

  // A platform operator acting under a specific (non-default) tenant gets a
  // persistent banner so they can't mutate the wrong tenant by accident. An
  // empty selection is the default/untenanted partition and needs no warning.
  const activeTenant = tenantSwitcher?.selected;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Modelgov Console</div>
        {tenantSwitcher && (
          <label className="tenant-switcher">
            <span className="metric-label">Tenant</span>
            <select value={tenantSwitcher.selected} onChange={(e) => tenantSwitcher.onChange(e.target.value)}>
              {/* No selection = the untenanted/default partition, NOT a
                  cross-tenant aggregate — reads are always tenant-partitioned. */}
              <option value="">Default (untenanted)</option>
              {tenantSwitcher.tenants.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
        )}
        <nav>
          {nav.map((item) => (
            <Link key={item.path} to={item.path} className={loc.pathname === item.path ? "active" : ""}>
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="hint">Metadata only — no prompt content unless capture is enabled server-side.</p>
      </aside>
      <main className="content">
        {activeTenant && (
          <div className="tenant-banner" role="status">
            Acting as tenant <strong>{activeTenant}</strong> — reads and writes on
            this page apply to this tenant. Switch to “Default (untenanted)” to leave it.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) return <Navigate to={`/login${location.search}`} replace />;
  return <>{children}</>;
}

/**
 * Auth gate + one-time whoami fetch for the whole session. A platform (unbound)
 * operator also gets a tenant switcher; changing it re-keys the page subtree so
 * every page refetches under the newly-selected tenant (the header goes out on
 * each request via the api client).
 */
function ProtectedLayout() {
  const location = useLocation();
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  const [tenants, setTenants] = useState<string[]>([]);
  const [tenant, setTenant] = useState(() => getTenant());

  useEffect(() => {
    if (!getToken()) return;
    fetchWhoami()
      .then((w) => {
        setWhoami(w);
        if (!w.tenantBound) fetchTenants().then(setTenants).catch(() => setTenants([]));
      })
      .catch(() => setWhoami(null));
  }, []);

  // First-run: guided setup before the operational dashboard.
  if (getToken() && !isSetupComplete()) {
    return <Navigate to="/setup" replace />;
  }

  // Keep ?url=&token= from ./setup autoconnect links when bouncing to login.
  if (!getToken()) return <Navigate to={`/login${location.search}`} replace />;

  const onTenantChange = (t: string) => {
    persistTenant(t);
    setTenant(t);
  };
  const switcher: TenantSwitcher | undefined =
    whoami && !whoami.tenantBound ? { tenants, selected: tenant, onChange: onTenantChange } : undefined;

  return (
    <WhoamiContext.Provider value={whoami}>
      <Shell tenantSwitcher={switcher}>
        {/* Re-key on tenant so all pages remount and refetch under the new scope. */}
        <div key={tenant || "__all__"}>
          <Outlet />
        </div>
      </Shell>
    </WhoamiContext.Provider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupGate><SetupWizardPage /></SetupGate>} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/policy" element={<PolicyPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/metrics" element={<MetricsPage />} />
        <Route path="/health" element={<HealthPage />} />
      </Route>
    </Routes>
  );
}
