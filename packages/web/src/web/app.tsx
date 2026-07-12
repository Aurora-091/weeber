import { Route, Switch } from "wouter";                                                                                
import DocsPage from "./pages/docs";
import LandingPage from "./pages/landing";                                                                                   
import { Provider } from "./components/provider";                                                                      
import { AgentFeedback } from "@runablehq/website-runtime";
import { AdminKeyGate } from "./components/dashboard/admin-key-gate";
import { DashboardShell } from "./components/dashboard/dashboard-shell";

// Admin dashboard pages
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

// Merchant app pages
import { MerchantLoginPage } from "./pages/app/login";
import { MerchantAuthCallbackPage } from "./pages/app/auth-callback";
import { ResetPasswordPage } from "./pages/app/reset-password";
import { MerchantOnboardingPage } from "./pages/app/onboarding";
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
        <Route path="/" component={LandingPage} />
        <Route path="/docs" component={DocsPage} />
        
        {/* Admin Dashboard */}
        <Route path="/dashboard">
          <Dashboard><CallsListPage /></Dashboard>
        </Route>
        <Route path="/dashboard/calls/:id">
          <Dashboard><CallDetailPage /></Dashboard>
        </Route>
        <Route path="/dashboard/dnc">
          <Dashboard><DncPage /></Dashboard>
        </Route>
        <Route path="/dashboard/audit">
          <Dashboard><AuditPage /></Dashboard>
        </Route>
        <Route path="/dashboard/settings">
          <Dashboard><SettingsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/agents">
          <Dashboard><AgentsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/analytics">
          <Dashboard><AnalyticsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/orgs">
          <Dashboard><OrgsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/templates">
          <Dashboard><TemplatesPage /></Dashboard>
        </Route>
        <Route path="/dashboard/billing">
          <Dashboard><BillingPage /></Dashboard>
        </Route>
        <Route path="/dashboard/compliance">
          <Dashboard><CompliancePage /></Dashboard>
        </Route>
        <Route path="/dashboard/flags">
          <Dashboard><FlagsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/users">
          <Dashboard><UsersPage /></Dashboard>
        </Route>
        <Route path="/dashboard/waitlist">
          <Dashboard><WaitlistPage /></Dashboard>
        </Route>
        <Route path="/dashboard/broadcasts">
          <Dashboard><BroadcastsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/support">
          <Dashboard><SupportPage /></Dashboard>
        </Route>
        <Route path="/dashboard/logs">
          <Dashboard><LogsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/revenue-analytics">
          <Dashboard><RevenueAnalyticsPage /></Dashboard>
        </Route>
        <Route path="/dashboard/marketing-analytics">
          <Dashboard><MarketingAnalyticsPage /></Dashboard>
        </Route>

        {/* Merchant App */}
        <Route path="/app/login"><MerchantLoginPage /></Route>
        <Route path="/app/auth/callback"><MerchantAuthCallbackPage /></Route>
        <Route path="/app/auth/reset-password"><ResetPasswordPage /></Route>
        
        <Route path="/app">
          <MerchantShell><MerchantOnboardingPage /></MerchantShell>
        </Route>
        <Route path="/app/onboarding">
          <MerchantShell><MerchantOnboardingPage /></MerchantShell>
        </Route>
        <Route path="/app/agents">
          <MerchantShell><MerchantAgentsPage /></MerchantShell>
        </Route>
        <Route path="/app/calls">
          <MerchantShell><MerchantCallsPage /></MerchantShell>
        </Route>
        <Route path="/app/calls/:id">
          <MerchantShell><MerchantCallDetailPage /></MerchantShell>
        </Route>
        <Route path="/app/analytics">
          <MerchantShell><MerchantAnalyticsPage /></MerchantShell>
        </Route>
        <Route path="/app/billing">
          <MerchantShell><MerchantBillingPage /></MerchantShell>
        </Route>
        <Route path="/app/integrations">
          <MerchantShell><MerchantIntegrationsPage /></MerchantShell>
        </Route>
      </Switch>                                                                                                        
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}                                                  
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>                                                                                                        
  );                                                                                                                   
}                                                                                                                      
                                                                                                                      
export default App; 