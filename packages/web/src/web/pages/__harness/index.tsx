/**
 * URL-addressable, backend-free render harness for the visual-regression and
 * a11y suites (Phase 0.6 of docs/archive/ui-implementation-plan.md).
 *
 * Every private page is reachable at `/__harness/<key>` with no auth, no
 * Supabase session, no admin key and no API. That is the whole point: CI stays
 * secret-free, so `visual` and `a11y` can run on a fork PR and cannot go
 * false-red because a token expired or a database was empty.
 *
 * WHY A HARNESS AND NOT REAL LOGIN
 * The alternative was minting an HS256 Supabase JWT in CI, which needs
 * SUPABASE_JWT_SECRET as a GitHub Actions secret. That trades a permanent
 * secret in CI for screenshots that still would not be deterministic, because
 * the rendered data would then depend on whatever the database happened to
 * contain that day. Mock data is both safer and more stable.
 *
 * WHY NOT `import.meta.env.DEV`
 * pages/__preview.tsx is DEV-gated, which is right for a hand-driven tool. It
 * cannot work here: playwright.config.ts serves a PRODUCTION build via
 * `vite preview` (deliberately — the suite tests the shipped artifact), and in
 * a production build DEV is false, so a DEV-gated route does not exist. So the
 * gate is DEV *or* an explicit build flag, and the visual suite is the only
 * thing that ever sets that flag.
 *
 * PRODUCTION SAFETY
 * `VITE_UI_HARNESS` is set in exactly one place: the `webServer.command` of
 * playwright.visual.config.ts. No deploy target sets it, so every real build
 * tree-shakes this module out. It also carries nothing worth reaching — the
 * mock org is hardcoded and there is no network call behind it.
 *
 * DETERMINISM RULES for anything added here:
 *   1. No `new Date()`, no `Date.now()`, no random ids. Time-derived text
 *      re-renders differently every run and the screenshot diff goes red for
 *      no reason.
 *   2. Seed via `client.setQueryData` before first paint, never in an effect.
 *   3. Fixed-length strings. A name that wraps at one length and not another
 *      changes layout height.
 */
import { useParams } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../../components/shell/app-shell";
import { DashboardShell } from "../../components/dashboard/dashboard-shell";
import { UserContext, type UserContextValue } from "../../components/app/user-shell";
import { getVertical } from "../../lib/verticals";
import { makeHarnessClient, mockMe } from "./fixtures";
import { HARNESS_KEYS, type HarnessKey } from "./keys";

// ---------------------------------------------------------------- /app pages
import { UserHomePage } from "../app/home";
import { UserAgentsPage } from "../app/agents";
import { UserCallsPage } from "../app/calls";
import { UserBillingPage } from "../app/billing";
import { UserIntegrationsPage } from "../app/integrations";
import { UserKnowledgeBasePage } from "../app/knowledge-base";
import { UserNumbersPage } from "../app/numbers";
import { UserOrdersPage } from "../app/orders";
import { UserLeadsPage } from "../app/leads";
import { UserSettingsPage } from "../app/settings";
import { UserWorkflowsListPage } from "../app/workflows";

// ----------------------------------------------------------- /dashboard pages
import { CallsListPage } from "../dashboard/calls-list";
import { OrgsPage } from "../dashboard/orgs";
import { AgentsPage } from "../dashboard/agents";
import { AnalyticsPage } from "../dashboard/analytics";
import { WaitlistPage } from "../dashboard/waitlist";
import { SettingsPage } from "../dashboard/settings";
import { CompliancePage } from "../dashboard/compliance";
import { DncPage } from "../dashboard/dnc";
import { UsersPage } from "../dashboard/users";
import { BillingPage } from "../dashboard/billing";
import { TemplatesPage } from "../dashboard/templates";
import { FlagsPage } from "../dashboard/flags";

type Surface = "app" | "dashboard";
type Entry = { surface: Surface; Comp: React.ComponentType };

/**
 * The page map. Typed as `Record<HarnessKey, Entry>` against keys.ts, so adding
 * a page here without adding its key there (or the reverse) is a typecheck
 * error rather than a silently missing baseline.
 */
export const HARNESS_PAGES: Record<HarnessKey, Entry> = {
  "app-home": { surface: "app", Comp: UserHomePage },
  "app-agents": { surface: "app", Comp: UserAgentsPage },
  "app-calls": { surface: "app", Comp: UserCallsPage },
  "app-billing": { surface: "app", Comp: UserBillingPage },
  "app-integrations": { surface: "app", Comp: UserIntegrationsPage },
  "app-knowledge-base": { surface: "app", Comp: UserKnowledgeBasePage },
  "app-numbers": { surface: "app", Comp: UserNumbersPage },
  "app-orders": { surface: "app", Comp: UserOrdersPage },
  "app-leads": { surface: "app", Comp: UserLeadsPage },
  "app-settings": { surface: "app", Comp: UserSettingsPage },
  "app-workflows": { surface: "app", Comp: UserWorkflowsListPage },

  "dash-calls": { surface: "dashboard", Comp: CallsListPage },
  "dash-orgs": { surface: "dashboard", Comp: OrgsPage },
  "dash-agents": { surface: "dashboard", Comp: AgentsPage },
  "dash-analytics": { surface: "dashboard", Comp: AnalyticsPage },
  "dash-waitlist": { surface: "dashboard", Comp: WaitlistPage },
  "dash-settings": { surface: "dashboard", Comp: SettingsPage },
  "dash-compliance": { surface: "dashboard", Comp: CompliancePage },
  "dash-dnc": { surface: "dashboard", Comp: DncPage },
  "dash-users": { surface: "dashboard", Comp: UsersPage },
  "dash-billing": { surface: "dashboard", Comp: BillingPage },
  "dash-templates": { surface: "dashboard", Comp: TemplatesPage },
  "dash-flags": { surface: "dashboard", Comp: FlagsPage },
};

// One client for the whole harness lifetime. Created at module scope, not in
// the component, so a React StrictMode double-render cannot hand two different
// caches to two renders of the same page.
const client = makeHarnessClient();

function AppSurface({ Comp }: { Comp: React.ComponentType }) {
  const vertical = getVertical(mockMe.org?.vertical ?? "shopify");
  const ctx: UserContextValue = {
    me: mockMe,
    vertical,
    flags: {},
    isFlagEnabled: () => false,
  };
  return (
    <UserContext.Provider value={ctx}>
      <AppShell
        density="spacious"
        collapsible
        nav={vertical.nav}
        brand={<span className="font-display text-base font-semibold tracking-tight">Weeber</span>}
      >
        <Comp />
      </AppShell>
    </UserContext.Provider>
  );
}

export function VisualHarness() {
  const { key } = useParams<{ key: string }>();
  const entry = key ? HARNESS_PAGES[key as HarnessKey] : undefined;

  if (!entry) {
    // Loud, not blank. A silent blank page here would be screenshotted as a
    // "passing" baseline and the gate would protect nothing.
    return (
      <div data-harness-error className="p-8 font-mono text-sm">
        <p className="font-semibold">unknown harness key: {String(key)}</p>
        <p className="mt-2">known keys:</p>
        <ul className="mt-1 list-inside list-disc">
          {HARNESS_KEYS.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      </div>
    );
  }

  const { surface, Comp } = entry;
  return (
    <QueryClientProvider client={client}>
      <div data-harness={key} data-harness-ready>
        {surface === "app" ? (
          <AppSurface Comp={Comp} />
        ) : (
          <DashboardShell>
            <Comp />
          </DashboardShell>
        )}
      </div>
    </QueryClientProvider>
  );
}

export default VisualHarness;
