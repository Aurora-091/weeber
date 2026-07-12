import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles, Bot, PhoneCall, BarChart3 } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { useUser } from "../../components/app/user-shell";
import { SetupModal } from "../../components/app/setup-modal";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

/**
 * The user's default landing page (`/app`) — replaces the old
 * full-page onboarding route. See docs/DECISIONS.md "Setup modal, not a
 * setup page": setup now happens in <SetupModal>, opened on top of this
 * page instead of gating it.
 *
 * Layout mirrors Vocalist's Dashboard.tsx: a "finish setup" checklist card
 * while incomplete, vertical-driven metric tiles below it, quick links to
 * the deeper pages (Agents/Conversations/Analytics own their own detail).
 */

const STEP_LABELS: Record<string, string> = {
  pick_vertical: "Pick your business type",
  connect_tools: "Connect your store",
  create_agent: "Turn on an agent",
  test_and_golive: "Review and go live",
};

type OnboardingState = { steps: Record<string, boolean>; dismissed: boolean; completedAt: string | null };
type AnalyticsOverview = { totalCalls: number };

export function UserHomePage() {
  const { vertical } = useUser();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [setupOpen, setSetupOpen] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const forceSetup = params.get("setup") === "1";

  const onboarding = useQuery({
    queryKey: ["app-onboarding"],
    queryFn: async () => {
      const res = await appFetch("/api/app/onboarding");
      if (!res.ok) throw new Error(`onboarding failed (${res.status})`);
      return (await res.json()) as OnboardingState;
    },
  });

  const analytics = useQuery({
    queryKey: ["app-analytics-overview"],
    queryFn: async () => {
      const res = await appFetch("/api/app/analytics?days=30");
      if (!res.ok) throw new Error(`analytics failed (${res.status})`);
      return (await res.json()) as AnalyticsOverview;
    },
  });

  // Auto-open once we know setup is incomplete — same gate Vocalist uses
  // (incomplete AND nothing live yet), so a user who explicitly
  // dismissed/skipped isn't re-interrupted on every visit.
  useEffect(() => {
    if (!onboarding.data) return;
    const steps = onboarding.data.steps ?? {};
    const isIncomplete = !Object.values(steps).every(Boolean) || Object.keys(steps).length === 0;
    if (forceSetup || (isIncomplete && !onboarding.data.dismissed)) {
      setSetupOpen(true);
    }
    if (forceSetup) {
      const url = new URL(window.location.href);
      url.searchParams.delete("setup");
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.data]);

  const steps = onboarding.data?.steps ?? {};
  const stepEntries = Object.entries(steps);
  const checklistDone = stepEntries.length > 0 && stepEntries.every(([, done]) => done);

  function dismissChecklist() {
    appFetch("/api/app/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    }).then(() => queryClient.invalidateQueries({ queryKey: ["app-onboarding"] }));
  }

  return (
    <div className="page-enter space-y-6">
      <PageHeader title="Home" description="Live operations across your agents and conversations." />

      {onboarding.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        !checklistDone &&
        !onboarding.data?.dismissed && (
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <div className="font-medium">Finish setting up Weeber</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stepEntries.filter(([, done]) => done).length} of {stepEntries.length || 4} done
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={dismissChecklist}>
                Dismiss
              </Button>
            </div>
            <div className="px-6 py-5">
              <ul className="space-y-2">
                {stepEntries.map(([key, done]) => (
                  <li key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex size-5 items-center justify-center rounded-full ${
                          done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {done ? <Check className="size-3" /> : null}
                      </span>
                      <span className={done ? "text-muted-foreground line-through" : ""}>
                        {STEP_LABELS[key] || key}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-4" onClick={() => setSetupOpen(true)}>
                <Sparkles className="mr-1.5 size-3.5" />
                Resume setup
              </Button>
            </div>
          </div>
        )
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {analytics.isLoading ? (
          [...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground">Total calls (30d)</div>
              <div className="mt-1.5 text-xl font-semibold">{analytics.data?.totalCalls ?? 0}</div>
            </div>
            {vertical.dashboard.metrics.map((m) => (
              <div key={m.key} className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{m.label}</div>
                <div className="mt-1.5 text-xl font-semibold">—</div>
                {m.hint && <div className="mt-1 text-[11px] text-muted-foreground">{m.hint}</div>}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link to={appPath("/agents")}>
          <div className="flex items-start gap-3 rounded-lg border border-border p-5 transition-colors hover:border-primary/30">
            <Bot className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">Agents</div>
              <p className="mt-1 text-sm text-muted-foreground">Configure voice, tone, and tools per agent.</p>
            </div>
          </div>
        </Link>
        <Link to={appPath("/calls")}>
          <div className="flex items-start gap-3 rounded-lg border border-border p-5 transition-colors hover:border-primary/30">
            <PhoneCall className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">Conversations</div>
              <p className="mt-1 text-sm text-muted-foreground">{vertical.copy.callsEmptyBody}</p>
            </div>
          </div>
        </Link>
        <Link to={appPath("/analytics")}>
          <div className="flex items-start gap-3 rounded-lg border border-border p-5 transition-colors hover:border-primary/30">
            <BarChart3 className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">Analytics</div>
              <p className="mt-1 text-sm text-muted-foreground">Latency, tool usage, and outcomes in depth.</p>
            </div>
          </div>
        </Link>
      </div>

      <SetupModal
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onFinished={() => {
          queryClient.invalidateQueries({ queryKey: ["app-onboarding"] });
          queryClient.invalidateQueries({ queryKey: ["app-analytics-overview"] });
          navigate(appPath());
        }}
      />
    </div>
  );
}
