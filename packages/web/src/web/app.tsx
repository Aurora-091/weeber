import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { Loader as Loader2 } from "lucide-react";
import { Provider } from "./components/provider";
import { ChunkErrorBoundary } from "./components/chunk-error-boundary";
import { AgentFeedback } from "@runablehq/website-runtime";
import { adminUrl, appUrl } from "./lib/domains";
import { adminPath, appPath } from "./lib/route-base";

const surface = (import.meta.env.VITE_APP_SURFACE || "all") as "public" | "admin" | "user" | "all";
const showPublic = surface === "all" || surface === "public";
const showAdmin = surface === "all" || surface === "admin";
const showUser = surface === "all" || surface === "user";

function SubdomainRedirect({ target }: { target: string }) {
  if (target.startsWith("http")) {
    window.location.replace(target);
    return null;
  }
  return <Redirect to={target} />;
}

// Route-level code splitting: every page below is a separate build chunk.
// A dedicated per-surface build (VITE_APP_SURFACE=admin/=user) only ever
// renders its own showAdmin/showUser branch, so React never calls the
// lazy() factory for the other surface's pages -- those chunks exist in
// dist/ but are never fetched over the network. This is what actually keeps
// admin.weeber.ai from shipping the user app's code (and vice versa) --
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
const WorkflowsListPage = lazy(() =>
  import("./pages/dashboard/workflows-list").then((m) => ({ default: m.WorkflowsListPage })),
);
const WorkflowEditorPage = lazy(() =>
  import("./pages/dashboard/workflow-editor").then((m) => ({ default: m.WorkflowEditorPage })),
);

// User/user app shell + pages
const UserLoginPage = lazy(() => import("./pages/app/login").then((m) => ({ default: m.UserLoginPage })));
const UserAuthCallbackPage = lazy(() =>
  import("./pages/app/auth-callback").then((m) => ({ default: m.UserAuthCallbackPage })),
);
const ResetPasswordPage = lazy(() =>
  import("./pages/app/reset-password").then((m) => ({ default: m.ResetPasswordPage })),
);
const UserHomePage = lazy(() => import("./pages/app/home").then((m) => ({ default: m.UserHomePage })));
const UserAgentsPage = lazy(() =>
  import("./pages/app/agents").then((m) => ({ default: m.UserAgentsPage })),
);
const UserCallsPage = lazy(() => import("./pages/app/calls").then((m) => ({ default: m.UserCallsPage })));
const UserCallDetailPage = lazy(() =>
  import("./pages/app/call-detail").then((m) => ({ default: m.UserCallDetailPage })),
);
const UserBillingPage = lazy(() =>
  import("./pages/app/billing").then((m) => ({ default: m.UserBillingPage })),
);
const UserIntegrationsPage = lazy(() =>
  import("./pages/app/integrations").then((m) => ({ default: m.UserIntegrationsPage })),
);
const UserSettingsPage = lazy(() =>
  import("./pages/app/settings").then((m) => ({ default: m.UserSettingsPage })),
);
const UserWorkflowsListPage = lazy(() =>
  import("./pages/app/workflows").then((m) => ({ default: m.UserWorkflowsListPage })),
);
const UserWorkflowDetailPage = lazy(() =>
  import("./pages/app/workflows").then((m) => ({ default: m.UserWorkflowDetailPage })),
);
const UserShell = lazy(() =>
  import("./components/app/user-shell").then((m) => ({ default: m.UserShell })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function Dashboard({ children, fullBleed }: { children: React.ReactNode; fullBleed?: boolean }) {
  return (
    <AdminKeyGate>
      <DashboardShell fullBleed={fullBleed}>{children}</DashboardShell>
    </AdminKeyGate>
  );
}

function App() {
  return (
    <Provider>
      <ChunkErrorBoundary>
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
              <Dashboard fullBleed><AgentsPage /></Dashboard>
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
          {showAdmin && (
            <Route path={adminPath("/workflows")}>
              <Dashboard><WorkflowsListPage /></Dashboard>
            </Route>
          )}
          {showAdmin && (
            <Route path={adminPath("/workflows/:id")}>
              <Dashboard><WorkflowEditorPage /></Dashboard>
            </Route>
          )}

          {/* User/User App */}
          {showUser && <Route path={appPath("/login")}><UserLoginPage /></Route>}
          {showUser && <Route path={appPath("/auth/callback")}><UserAuthCallbackPage /></Route>}
          {showUser && <Route path={appPath("/auth/reset-password")}><ResetPasswordPage /></Route>}

          {showUser && (
            <Route path={appPath()}>
              <UserShell><UserHomePage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/onboarding")}>
              <Redirect to={`${appPath()}?setup=1`} />
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/agents")}>
              <UserShell fullBleed><UserAgentsPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/calls")}>
              <UserShell><UserCallsPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/calls/:id")}>
              <UserShell><UserCallDetailPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/billing")}>
              <UserShell><UserBillingPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/integrations")}>
              <UserShell><UserIntegrationsPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/settings")}>
              <UserShell><UserSettingsPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/workflows")}>
              <UserShell><UserWorkflowsListPage /></UserShell>
            </Route>
          )}
          {showUser && (
            <Route path={appPath("/workflows/:id")}>
              <UserShell><UserWorkflowDetailPage /></UserShell>
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
             surface === "user" ? <Redirect to={appPath()} /> :
             <Redirect to="/" />}
          </Route>
        </Switch>
      </Suspense>
      </ChunkErrorBoundary>
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
