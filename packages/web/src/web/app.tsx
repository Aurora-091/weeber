import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { Loader2 } from "lucide-react";
import { Provider } from "./components/provider";
import { AgentFeedback } from "@runablehq/website-runtime";
import { adminUrl, appUrl } from "./lib/domains";
import { adminPath, appPath } from "./lib/route-base";

const surface = (import.meta.env.VITE_APP_SURFACE || "all") as "public" | "admin" | "merchant" | "all";
const showPublic = surface === "all" || surface === "public";
const showAdmin = surface === "all" || surface === "admin";
const showMerchant = surface === "all" || surface === "merchant";

function SubdomainRedirect({ target }: { target: string }) {
  if (target.startsWith("http")) {
    window.location.replace(target);
    return null;
  }
  return <Redirect to={target} />;
}

// Route-level code splitting: every page below is a separate build chunk.
// A dedicated per-surface build (VITE_APP_SURFACE=admin/=merchant) only ever
// renders its own showAdmin/showMerchant branch, so React never calls the
// lazy() factory for the other surface's pages -- those chunks exist in
// dist/ but are never fetched over the network. This is what actually keeps
// admin.weeber.ai from shipping the merchant app's code (and vice versa) --
// the VITE_APP_SURFACE env check alone only gated *rendering*, not bundling,
// since every import below used to be a static top-level import.

// Public marketing pages
const LandingPage = lazy(() => import("./pages/landing"));
const DocsPage = lazy(() => import("./pages/docs"));

// Admin dashboard shell + pages
const AdminKeyGate = lazy(() =>
  import("./components/dashboard/admin-key-gate").then((m) => ({ default: m.AdminKeyGate })),
);
const DashboardShell = lazy(() =>
  import("./components/dashboard/dashboard-shell").then((m) => ({ default: m.DashboardShell })),
);
const CallsListPage = lazy(() => import("./pages/dashboard/calls-list").then((m) => ({ default: m.CallsListPage })));
const CallDetailPage = lazy(() =>
  import("./pages/dashboard/call-detail").then((m) => ({ default: m.CallDetailPage })),
);
const DncPage = lazy(() => import("./pages/dashboard/dnc").then((m) => ({ default: m.DncPage })));
const AuditPage = lazy(() => import("./pages/dashboard/audit").then((m) => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import("./pages/dashboard/settings").then((m) => ({ default: m.SettingsPage })));
const AgentsPage = lazy(() => import("./pages/dashboard/agents").then((m) => ({ default: m.AgentsPage })));
const AnalyticsPage = lazy(() =>
  import("./pages/dashboard/analytics").then((m) => ({ default: m.AnalyticsPage })),
);
const OrgsPage = lazy(() => import("./pages/dashboard/orgs").then((m) => ({ default: m.OrgsPage })));
const TemplatesPage = lazy(() =>
  import("./pages/dashboard/templates").then((m) => ({ default: m.TemplatesPage })),
);
const BillingPage = lazy(() => import("./pages/dashboard/billing").then((m) => ({ default: m.BillingPage })));
const CompliancePage = lazy(() =>
  import("./pages/dashboard/compliance").then((m) => ({ default: m.CompliancePage })),
);
const FlagsPage = lazy(() => import("./pages/dashboard/flags").then((m) => ({ default: m.FlagsPage })));
const UsersPage = lazy(() => import("./pages/dashboard/users").then((m) => ({ default: m.UsersPage })));
const WaitlistPage = lazy(() => import("./pages/dashboard/waitlist").then((m) => ({ default: m.WaitlistPage })));
const BroadcastsPage = lazy(() =>
  import("./pages/dashboard/broadcasts").then((m) => ({ default: m.BroadcastsPage })),
);
const SupportPage = lazy(() => import("./pages/dashboard/support").then((m) => ({ default: m.SupportPage })));
const LogsPage = lazy(() => import("./pages/dashboard/logs").then((m) => ({ default: m.LogsPage })));
const RevenueAnalyticsPage = lazy(() =>
  import("./pages/dashboard/revenue-analytics").then((m) => ({ default: m.RevenueAnalyticsPage })),
);
const MarketingAnalyticsPage = lazy(() =>
  import("./pages/dashboard/marketing-analytics").then((m) => ({ default: m.MarketingAnalyticsPage })),
);
const WorkflowRunsPage = lazy(() =>
  import("./pages/dashboard/workflow-runs").then((m) => ({ default: m.WorkflowRunsPage })),
);

// Merchant/user app shell + pages
const MerchantLoginPage = lazy(() => import("./pages/app/login").then((m) => ({ default: m.MerchantLoginPage })));
const MerchantAuthCallbackPage = lazy(() =>
  import("./pages/app/auth-callback").then((m) => ({ default: m.MerchantAuthCallbackPage })),
);
const ResetPasswordPage = lazy(() =>
  import("./pages/app/reset-password").then((m) => ({ default: m.ResetPasswordPage })),
);
const MerchantHomePage = lazy(() => import("./pages/app/home").then((m) => ({ default: m.MerchantHomePage })));
const MerchantAgentsPage = lazy(() =>
  import("./pages/app/agents").then((m) => ({ default: m.MerchantAgentsPage })),
);
const MerchantCallsPage = lazy(() => import("./pages/app/calls").then((m) => ({ default: m.MerchantCallsPage })));
const MerchantCallDetailPage = lazy(() =>
  import("./pages/app/call-detail").then((m) => ({ default: m.MerchantCallDetailPage })),
);
const MerchantAnalyticsPage = lazy(() =>
  import("./pages/app/analytics").then((m) => ({ default: m.MerchantAnalyticsPage })),
);
const MerchantBillingPage = lazy(() =>
  import("./pages/app/billing").then((m) => ({ default: m.MerchantBillingPage })),
);
const MerchantIntegrationsPage = lazy(() =>
  import("./pages/app/integrations").then((m) => ({ default: m.MerchantIntegrationsPage })),
);
const MerchantShell = lazy(() =>
  import("./components/app/merchant-shell").then((m) => ({ default: m.MerchantShell })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function Dashboard({ children }: { children: React.ReactNode }) {
  return (
    <AdminKeyGate>
      <DashboardShell>{children}</DashboardShell>
    </AdminKeyGate>
  );
}

function App() {
  return (
    <Provider>
      <Suspense fallback={<RouteFallback />}>
        <Switch>
          {/* Public pages */}
          {showPublic && <Route path="/" component={LandingPage} />}
          {showPublic && <Route path="/docs" component={DocsPage} />}

          {/* Admin Dashboard */}
          {showAdmin && (
            <Route path={adminPath()}>
              <Dashboard><CallsListPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/calls/:id")}>
              <Dashboard><CallDetailPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/dnc")}>
              <Dashboard><DncPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/audit")}>
              <Dashboard><AuditPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/settings")}>
              <Dashboard><SettingsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/agents")}>
              <Dashboard><AgentsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/analytics")}>
              <Dashboard><AnalyticsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/orgs")}>
              <Dashboard><OrgsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/templates")}>
              <Dashboard><TemplatesPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/billing")}>
              <Dashboard><BillingPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/compliance")}>
              <Dashboard><CompliancePage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/flags")}>
              <Dashboard><FlagsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/users")}>
              <Dashboard><UsersPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/waitlist")}>
              <Dashboard><WaitlistPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/broadcasts")}>
              <Dashboard><BroadcastsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/support")}>
              <Dashboard><SupportPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/logs")}>
              <Dashboard><LogsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/revenue-analytics")}>
              <Dashboard><RevenueAnalyticsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/marketing-analytics")}>
              <Dashboard><MarketingAnalyticsPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/workflow-runs")}>
              <Dashboard><WorkflowRunsPage /></Dashboard>
            </Route>
          )}

          {/* Merchant/User App */}
          {showMerchant && <Route path={appPath("/login")}><MerchantLoginPage /></Route>}
          {showMerchant && <Route path={appPath("/auth/callback")}><MerchantAuthCallbackPage /></Route>}
          {showMerchant && <Route path={appPath("/auth/reset-password")}><ResetPasswordPage /></Route>}

          {showMerchant && (
            <Route path={appPath()}>
              <MerchantShell><MerchantHomePage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/onboarding")}>
              <Redirect to={`${appPath()}?setup=1`} />
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/agents")}>
              <MerchantShell><MerchantAgentsPage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/calls")}>
              <MerchantShell><MerchantCallsPage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/calls/:id")}>
              <MerchantShell><MerchantCallDetailPage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/analytics")}>
              <MerchantShell><MerchantAnalyticsPage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/billing")}>
              <MerchantShell><MerchantBillingPage /></MerchantShell>
            </Route>
          )}
          {showMerchant && (
            <Route path={appPath("/integrations")}>
              <MerchantShell><MerchantIntegrationsPage /></MerchantShell>
            </Route>
          )}

          {/* Legacy-prefix redirect: old "/dashboard/..." and "/app/..." links
              (bookmarks, external references from the single-deploy era)
              forwarded to the correct surface's real origin/path. Harmless
              no-ops in combined "all" mode since the real prefixed routes
              above always match first -- only actually fires once a dedicated
              per-surface build has dropped these prefixes from its own route
              list. */}
          <Route path="/dashboard/:rest*">
            <SubdomainRedirect target={adminUrl(window.location.pathname.replace(/^\/dashboard/, ""))} />
          </Route>
          <Route path="/app/:rest*">
            <SubdomainRedirect target={appUrl(window.location.pathname.replace(/^\/app/, ""))} />
          </Route>

          {/* Fallback: redirect to this surface's own root. */}
          <Route>
            {surface === "admin" ? <Redirect to={adminPath()} /> :
             surface === "merchant" ? <Redirect to={appPath()} /> :
             <Redirect to="/" />}
          </Route>
        </Switch>
      </Suspense>
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
