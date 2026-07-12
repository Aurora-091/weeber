import { Redirect, Route, Switch } from "wouter";                                                                                
import DocsPage from "./pages/docs";
import LandingPage from "./pages/landing";                                                                                   
import { Provider } from "./components/provider";                                                                      
import { AgentFeedback } from "@runablehq/website-runtime";
import { adminUrl, appUrl } from "./lib/domains";

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

// Admin dashboard pages (lazy-loaded when surface includes admin)
import { AdminKeyGate } from "./components/dashboard/admin-key-gate";
import { DashboardShell } from "./components/dashboard/dashboard-shell";
import { CallsListPage } from "./pages/dashboard/calls-list";
import { CallDetailPage } from "./pages/dashboard/call-detail";
import { DncPage } from "./pages/dashboard/dnc";
import { AuditPage } from "./pages/dashboard/audit";
import { SettingsPage } from "./pages/dashboard/settings";
import { AgentsPage } from "./pages/dashboard/agents";
import { AnalyticsPage } from "./pages/dashboard/analytics";
import { OrgsPage } from "./pages/dashboard/orgs";
import { TemplatesPage } from "./pages/dashboard/templates";
import { BillingPage } from "./pages/dashboard/billing";
import { CompliancePage } from "./pages/dashboard/compliance";
import { FlagsPage } from "./pages/dashboard/flags";
import { UsersPage } from "./pages/dashboard/users";
import { WaitlistPage } from "./pages/dashboard/waitlist";
import { BroadcastsPage } from "./pages/dashboard/broadcasts";
import { SupportPage } from "./pages/dashboard/support";
import { LogsPage } from "./pages/dashboard/logs";
import { RevenueAnalyticsPage } from "./pages/dashboard/revenue-analytics";
import { MarketingAnalyticsPage } from "./pages/dashboard/marketing-analytics";
import { WorkflowRunsPage } from "./pages/dashboard/workflow-runs";

// Merchant app pages
import { MerchantLoginPage } from "./pages/app/login";
import { MerchantAuthCallbackPage } from "./pages/app/auth-callback";
import { ResetPasswordPage } from "./pages/app/reset-password";
import { MerchantHomePage } from "./pages/app/home";
import { MerchantAgentsPage } from "./pages/app/agents";
import { MerchantCallsPage } from "./pages/app/calls";
import { MerchantCallDetailPage } from "./pages/app/call-detail";
import { MerchantAnalyticsPage } from "./pages/app/analytics";
import { MerchantBillingPage } from "./pages/app/billing";
import { MerchantIntegrationsPage } from "./pages/app/integrations";
import { MerchantShell } from "./components/app/merchant-shell";

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
      <Switch>                                                                                                         
        {/* Public pages */}
        {showPublic && <Route path="/" component={LandingPage} />}
        {showPublic && <Route path="/docs" component={DocsPage} />}
        
        {/* Admin Dashboard */}
        {showAdmin && (
          <Route path="/dashboard">
            <Dashboard><CallsListPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/calls/:id">
            <Dashboard><CallDetailPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/dnc">
            <Dashboard><DncPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/audit">
            <Dashboard><AuditPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/settings">
            <Dashboard><SettingsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/agents">
            <Dashboard><AgentsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/analytics">
            <Dashboard><AnalyticsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/orgs">
            <Dashboard><OrgsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/templates">
            <Dashboard><TemplatesPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/billing">
            <Dashboard><BillingPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/compliance">
            <Dashboard><CompliancePage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/flags">
            <Dashboard><FlagsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/users">
            <Dashboard><UsersPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/waitlist">
            <Dashboard><WaitlistPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/broadcasts">
            <Dashboard><BroadcastsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/support">
            <Dashboard><SupportPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/logs">
            <Dashboard><LogsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/revenue-analytics">
            <Dashboard><RevenueAnalyticsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/marketing-analytics">
            <Dashboard><MarketingAnalyticsPage /></Dashboard>
          </Route>
        )}
        {showAdmin && (
          <Route path="/dashboard/workflow-runs">
            <Dashboard><WorkflowRunsPage /></Dashboard>
          </Route>
        )}

        {/* Merchant App */}
        {showMerchant && <Route path="/app/login"><MerchantLoginPage /></Route>}
        {showMerchant && <Route path="/app/auth/callback"><MerchantAuthCallbackPage /></Route>}
        {showMerchant && <Route path="/app/auth/reset-password"><ResetPasswordPage /></Route>}
        
        {showMerchant && (
          <Route path="/app">
            <MerchantShell><MerchantHomePage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/onboarding">
            <Redirect to="/app?setup=1" />
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/agents">
            <MerchantShell><MerchantAgentsPage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/calls">
            <MerchantShell><MerchantCallsPage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/calls/:id">
            <MerchantShell><MerchantCallDetailPage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/analytics">
            <MerchantShell><MerchantAnalyticsPage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/billing">
            <MerchantShell><MerchantBillingPage /></MerchantShell>
          </Route>
        )}
        {showMerchant && (
          <Route path="/app/integrations">
            <MerchantShell><MerchantIntegrationsPage /></MerchantShell>
          </Route>
        )}

        {/* Cross-subdomain redirect: if a user hits a path that belongs to a
            different surface, send them to the correct subdomain rather than
            showing a blank page. Only fires in production (origins set). */}
        <Route path="/dashboard/:rest*">
          <SubdomainRedirect target={adminUrl(window.location.pathname)} />
        </Route>
        <Route path="/app/:rest*">
          <SubdomainRedirect target={appUrl(window.location.pathname)} />
        </Route>

        {/* Fallback: redirect to the appropriate root */}
        <Route>
          {surface === "admin" ? <Redirect to="/dashboard" /> :
           surface === "merchant" ? <Redirect to="/app" /> :
           <Redirect to="/" />}
        </Route>
      </Switch>
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>                                                                                                        
  );                                                                                                                   
}                                                                                                                      
                                                                                                                      
export default App;
