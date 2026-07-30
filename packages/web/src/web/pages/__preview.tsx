/**
 * DEV-ONLY structural preview harness.
 *
 * Mounts the REAL AppShell + REAL /app page components with a mock user
 * context and an isolated QueryClient (retry:false), so shell/page structure
 * — nav-intent prefetch, page containers, card primitives, z-index/overflow —
 * can be verified in a browser without a backend or Supabase secrets. Data
 * fetches fail fast to empty/error states, which is exactly enough to inspect
 * layout structure.
 *
 * This module is only ever reached from a route gated behind
 * `import.meta.env.DEV` (see app.tsx), so it is tree-shaken out of every
 * production build. Do not import it from production code.
 */
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/shell/app-shell";
import { UserContext, type UserContextValue, type UserMe } from "../components/app/user-shell";
import { getVertical } from "../lib/verticals";
import { useShellFullBleed } from "../components/shell/app-shell";
import { UserHomePage } from "./app/home";
import { UserAgentsPage } from "./app/agents";
import { UserIntegrationsPage } from "./app/integrations";
import { UserWorkflowsListPage } from "./app/workflows";
import { UserCallsPage } from "./app/calls";
import { UserSettingsPage } from "./app/settings";

const previewClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } },
});

const mockMe: UserMe = {
  user: { id: "preview-user", email: "preview@weeber.ai" },
  role: "owner",
  needsOnboarding: false,
  org: {
    id: "preview-org",
    name: "Preview Store",
    status: "active",
    vertical: "shopify",
    planName: "Growth",
    currency: "USD",
    countryCode: "US",
    timezone: "UTC",
    contactEmail: "preview@weeber.ai",
    webhookUrl: null,
    humanTransferNumber: null,
    callingWindowTestModeUntil: null,
  },
};

/** Synthetic full-bleed probe — verifies AppShell's full-bleed <main> variant
 * fills the viewport edge-to-edge with no overflow/scroll (same mechanism the
 * workflow canvas uses via useShellFullBleed()). */
function FullBleedProbe() {
  useShellFullBleed();
  return (
    <div className="page-enter flex h-full flex-col p-4 sm:p-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <span className="text-sm font-medium">Full-bleed header row</span>
        <span className="text-xs text-muted-foreground">no page padding / no doc scroll</span>
      </div>
      <div className="mt-4 flex flex-1 overflow-hidden rounded-lg">
        <div className="flex-1 rounded-lg bg-muted/40 ring-1 ring-inset ring-border grid place-items-center text-xs text-muted-foreground">
          canvas fills remaining height
        </div>
        <div className="ml-4 w-72 shrink-0 rounded-lg border border-border p-4 text-xs text-muted-foreground">
          side panel
        </div>
      </div>
    </div>
  );
}

const PAGES = {
  home: { label: "Home", Comp: UserHomePage },
  fullbleed: { label: "Full-bleed probe", Comp: FullBleedProbe },
  agents: { label: "Agents", Comp: UserAgentsPage },
  workflows: { label: "Workflows (full-bleed)", Comp: UserWorkflowsListPage },
  calls: { label: "Conversations", Comp: UserCallsPage },
  integrations: { label: "Integrations", Comp: UserIntegrationsPage },
  settings: { label: "Settings", Comp: UserSettingsPage },
} as const;

type PageKey = keyof typeof PAGES;

export function PreviewHarness() {
  const [page, setPage] = useState<PageKey>("integrations");
  const vertical = getVertical("shopify");
  const ctx: UserContextValue = {
    me: mockMe,
    vertical,
    flags: {},
    isFlagEnabled: () => false,
  };
  const { Comp } = PAGES[page];

  return (
    <QueryClientProvider client={previewClient}>
      <UserContext.Provider value={ctx}>
        {/* Floating page picker — outside the shell, above everything. */}
        <div className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-full border border-neutral-300 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
          <div className="flex items-center gap-1">
            <span className="px-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              preview
            </span>
            {(Object.keys(PAGES) as PageKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setPage(key)}
                className={
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
                  (page === key
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100")
                }
              >
                {PAGES[key].label}
              </button>
            ))}
          </div>
        </div>
        <AppShell
          density="spacious"
          collapsible
          nav={vertical.nav}
          brand={<span className="font-display text-base font-semibold tracking-tight">Weeber</span>}
        >
          <Comp />
        </AppShell>
      </UserContext.Provider>
    </QueryClientProvider>
  );
}

export default PreviewHarness;
