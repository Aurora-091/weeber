import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { Loader as Loader2 } from "lucide-react";
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

// Route-level code splitting
const LandingPage = lazy(() => import("./pages/landing"));
const DocsPage = lazy(() => import("./pages/docs"));
const ShopifySolutionPage = lazy(() => import("./pages/shopify").then((m) => ({ default: m.ShopifySolutionPage })));
const PricingPage = lazy(() => import("./pages/pricing").then((m) => ({ default: m.PricingPage })));
const AboutPage = lazy(() => import("./pages/about").then((m) => ({ default: m.AboutPage })));
const FaqPage = lazy(() => import("./pages/faq").then((m) => ({ default: m.FaqPage })));
const ContactPage = lazy(() => import("./pages/contact").then((m) => ({ default: m.ContactPage })));

const AdminKeyGate = lazy(() =>
  import("./components/dashboard/admin-key-gate").then((m) => ({ default: m.AdminKeyGate })),
);
const DashboardShell = lazy(() =>
  import("./components/dashboard/dashboard-shell").then((m) => ({ default: m.DashboardShell })),
);
const CallsListPage = lazy(() => import("./pages/dashboard/calls-list").then((m) => ({ default: m.CallsListPage })));
const CallDetailPage = lazy(() => import("./pages/dashboard/call-detail").then((m) => ({ default: m.CallDetailPage })));
const DncPage = lazy(() => import("./pages/dashboard/dnc").then((m) => ({ default: m.DncPage })));
const AuditPage = lazy(() => import("./pages/dashboard/audit").then((m) => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import("./pages/dashboard/settings").then((m) => ({ default: m.SettingsPage })));
const AgentsPage = lazy(() => import("./pages/dashboard/agents").then((m) => ({ default: m.AgentsPage })));
const AnalyticsPage = lazy(() => import("./pages/dashboard/analytics").then((m) => ({ default: m.AnalyticsPage })));
const OrgsPage = lazy(() => import("./pages/dashboard/orgs").then((m) => ({ default: m.OrgsPage })));
const TemplatesPage = lazy(() => import("./pages/dashboard/templates").then((m) => ({ default: m.TemplatesPage })));
const BillingPage = lazy(() => import("./pages/dashboard/billing").then((m) => ({ default: m.BillingPage })));
const CompliancePage = lazy(() => import("./pages/dashboard/compliance").then((m) => ({ default: m.CompliancePage })));
const FlagsPage = lazy(() => import("./pages/dashboard/flags").then((m) => ({ default: m.FlagsPage })));
const UsersPage = lazy(() => import("./pages/dashboard/users").then((m) => ({ default: m.UsersPage })));
const WaitlistPage = lazy(() => import("./pages/dashboard/waitlist").then((m) => ({ default: m.WaitlistPage })));
const BroadcastsPage = lazy(() => import("./pages/dashboard/broadcasts").then((m) => ({ default: m.BroadcastsPage })));
const SupportPage = lazy(() => import("./pages/dashboard/support").then((m) => ({ default: m.SupportPage })));
const LogsPage = lazy(() => import("./pages/dashboard/logs").then((m) => ({ default: m.LogsPage })));
const RevenueAnalyticsPage = lazy(() => import("./pages/dashboard/revenue-analytics").then((m) => ({ default: m.RevenueAnalyticsPage })));
const MarketingAnalyticsPage = lazy(() => import("./pages/dashboard/marketing-analytics").then((m) => ({ default: m.MarketingAnalyticsPage })));
const WorkflowRunsPage = lazy(() => import("./pages/dashboard/workflow-runs").then((m) => ({ default: m.WorkflowRunsPage })));
const WorkflowsListPage = lazy(() => import("./pages/dashboard/workflows-list").then((m) => ({ default: m.WorkflowsListPage })));
const WorkflowEditorPage = lazy(() => import("./pages/dashboard/workflow-editor").then((m) => ({ default: m.WorkflowEditorPage })));

const UserLoginPage = lazy(() => import("./pages/app/login").then((m) => ({ default: m.UserLoginPage })));
const UserAuthCallbackPage = lazy(() => import("./pages/app/auth-callback").then((m) => ({ default: m.UserAuthCallbackPage })));
const ResetPasswordPage = lazy(() => import("./pages/app/reset-password").then((m) => ({ default: m.ResetPasswordPage })));
const UserHomePage = lazy(() => import("./pages/app/home").then((m) => ({ default: m.UserHomePage })));
const UserAgentsPage = lazy(() => import("./pages/app/agents").then((m) => ({ default: m.UserAgentsPage })));
const UserCallsPage = lazy(() => import("./pages/app/calls").then((m) => ({ default: m.UserCallsPage })));
const UserCallDetailPage = lazy(() => import("./pages/app/call-detail").then((m) => ({ default: m.UserCallDetailPage })));
const UserBillingPage = lazy(() => import("./pages/app/billing").then((m) => ({ default: m.UserBillingPage })));
const UserIntegrationsPage = lazy(() => import("./pages/app/integrations").then((m) => ({ default: m.UserIntegrationsPage })));
const UserKnowledgeBasePage = lazy(() => import("./pages/app/knowledge-base").then((m) => ({ default: m.UserKnowledgeBasePage })));
const UserNumbersPage = lazy(() => import("./pages/app/numbers").then((m) => ({ default: m.UserNumbersPage })));
const UserSettingsPage = lazy(() => import("./pages/app/settings").then((m) => ({ default: m.UserSettingsPage })));
const UserWorkflowsListPage = lazy(() => import("./pages/app/workflows").then((m) => ({ default: m.UserWorkflowsListPage })));
const UserWorkflowDetailPage = lazy(() => import("./pages/app/workflows").then((m) => ({ default: m.UserWorkflowDetailPage })));
const UserShell = lazy(() => import("./components/app/user-shell").then((m) => ({ default: m.UserShell })));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Persistent user app layout — shell stays mounted across navigations.
 * Only the inner page content switches (no sidebar/auth-state remount).
 */
function UserAppRoutes() {
  return (
    <UserShell>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path={appPath()} component={UserHomePage} />
          <Route path={appPath("/agents")} component={UserAgentsPage} />
          <Route path={appPath("/calls")} component={UserCallsPage} />
          <Route path={appPath("/calls/:id")} component={UserCallDetailPage} />
          <Route path={appPath("/billing")} component={UserBillingPage} />
          <Route path={appPath("/integrations")} component={UserIntegrationsPage} />
          <Route path={appPath("/knowledge-base")} component={UserKnowledgeBasePage} />
          <Route path={appPath("/numbers")} component={UserNumbersPage} />
          <Route path={appPath("/settings")} component={UserSettingsPage} />
          <Route path={appPath("/workflows")} component={UserWorkflowsListPage} />
          <Route path={appPath("/workflows/:id")} component={UserWorkflowDetailPage} />
          <Route path={appPath("/onboarding")}>
            <Redirect to={`${appPath()}?setup=1`} />
          </Route>
          <Route><Redirect to={appPath()} /></Route>
        </Switch>
      </Suspense>
    </UserShell>
  );
}

/**
 * Persistent admin layout — shell stays mounted, inner pages switch.
 */
function AdminAppRoutes() {
  return (
    <AdminKeyGate>
      <DashboardShell>
        <Suspense fallback={<PageFallback />}>
          <Switch>
            <Route path={adminPath()} component={CallsListPage} />
            <Route path={adminPath("/calls/:id")} component={CallDetailPage} />
            <Route path={adminPath("/dnc")} component={DncPage} />
            <Route path={adminPath("/audit")} component={AuditPage} />
            <Route path={adminPath("/settings")} component={SettingsPage} />
            <Route path={adminPath("/agents")} component={AgentsPage} />
            <Route path={adminPath("/analytics")} component={AnalyticsPage} />
            <Route path={adminPath("/orgs")} component={OrgsPage} />
            <Route path={adminPath("/templates")} component={TemplatesPage} />
            <Route path={adminPath("/billing")} component={BillingPage} />
            <Route path={adminPath("/compliance")} component={CompliancePage} />
            <Route path={adminPath("/flags")} component={FlagsPage} />
            <Route path={adminPath("/users")} component={UsersPage} />
            <Route path={adminPath("/waitlist")} component={WaitlistPage} />
            <Route path={adminPath("/broadcasts")} component={BroadcastsPage} />
            <Route path={adminPath("/support")} component={SupportPage} />
            <Route path={adminPath("/logs")} component={LogsPage} />
            <Route path={adminPath("/revenue-analytics")} component={RevenueAnalyticsPage} />
            <Route path={adminPath("/marketing-analytics")} component={MarketingAnalyticsPage} />
            <Route path={adminPath("/workflow-runs")} component={WorkflowRunsPage} />
            <Route path={adminPath("/workflows")} component={WorkflowsListPage} />
            <Route path={adminPath("/workflows/:id")} component={WorkflowEditorPage} />
            <Route><Redirect to={adminPath()} /></Route>
          </Switch>
        </Suspense>
      </DashboardShell>
    </AdminKeyGate>
  );
}

function App() {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Switch>
          {/* Public pages */}
          {showPublic && <Route path="/" component={LandingPage} />}
          {showPublic && <Route path="/docs" component={DocsPage} />}
          {showPublic && <Route path="/shopify" component={ShopifySolutionPage} />}
          {showPublic && <Route path="/pricing" component={PricingPage} />}
          {showPublic && <Route path="/about" component={AboutPage} />}
          {showPublic && <Route path="/faq" component={FaqPage} />}
          {showPublic && <Route path="/contact" component={ContactPage} />}

          {/* User auth pages (no shell — must be BEFORE the catch-all) */}
          {showUser && <Route path={appPath("/login")} component={UserLoginPage} />}
          {showUser && <Route path={appPath("/auth/callback")} component={UserAuthCallbackPage} />}
          {showUser && <Route path={appPath("/auth/reset-password")} component={ResetPasswordPage} />}

          {/* User app — persistent shell wraps all authenticated pages */}
          {showUser && <Route path={appPath("/:rest*")}>{() => <UserAppRoutes />}</Route>}
          {showUser && <Route path={appPath()}>{() => <UserAppRoutes />}</Route>}

          {/* Admin dashboard — persistent shell wraps all admin pages */}
          {showAdmin && <Route path={adminPath("/:rest*")}>{() => <AdminAppRoutes />}</Route>}
          {showAdmin && <Route path={adminPath()}>{() => <AdminAppRoutes />}</Route>}

          {/* Legacy redirects */}
          <Route path="/dashboard/:rest*">
            <SubdomainRedirect target={adminUrl(window.location.pathname.replace(/^\/dashboard/, ""))} />
          </Route>
          <Route path="/app/:rest*">
            <SubdomainRedirect target={appUrl(window.location.pathname.replace(/^\/app/, ""))} />
          </Route>

          {/* Fallback */}
          <Route>
            {surface === "admin" ? <Redirect to={adminPath()} /> :
             surface === "user" ? <Redirect to={appPath()} /> :
             <Redirect to="/" />}
          </Route>
        </Switch>
      </Suspense>
      {import.meta.env.DEV && <AgentFeedback />}
    </ChunkErrorBoundary>
  );
}

export default App;
