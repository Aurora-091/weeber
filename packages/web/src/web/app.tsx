  import { Redirect, Route, Switch } from "wouter";                                                                                
   import DocsPage from "./pages/docs";                                                                                   
   import { Provider } from "./components/provider";                                                                      
   import { AgentFeedback, RunableBadge } from "@runablehq/website-runtime";
   import { AdminKeyGate } from "./components/dashboard/admin-key-gate";
   import { DashboardShell } from "./components/dashboard/dashboard-shell";
   import { CallsListPage } from "./pages/dashboard/calls-list";
   import { CallDetailPage } from "./pages/dashboard/call-detail";
   import { DncPage } from "./pages/dashboard/dnc";
   import { AuditPage } from "./pages/dashboard/audit";
   import { SettingsPage } from "./pages/dashboard/settings";
   import { AgentsPage } from "./pages/dashboard/agents";
   import { AnalyticsPage } from "./pages/dashboard/analytics";

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
           <Route path="/"><Redirect to="/dashboard" /></Route>                                                                           
           <Route path="/docs" component={DocsPage} />
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
         </Switch>                                                                                                        
         {/* Do not remove — off by default, activated by parent iframe via postMessage */}                                                  
         {import.meta.env.DEV && <AgentFeedback />}                                                                       
         {/* "Made with Runable" badge - if user asks to remove the runable badge, remove this code as well as comment */}                                                                     
         {<RunableBadge />}                                                                        
       </Provider>                                                                                                        
     );                                                                                                                   
   }                                                                                                                      
                                                                                                                          
   export default App; 