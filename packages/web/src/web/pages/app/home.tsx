import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles, Bot, PhoneCall, ChartBar as BarChart3, X } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { useUser } from "../../components/app/user-shell";
import { SetupModal } from "../../components/app/setup-modal";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

const STEP_LABELS: Record<string, string> = {
  pick_vertical: "Pick your business type",
  connect_tools: "Connect your store",
  create_agent: "Turn on an agent",
  test_and_golive: "Review and go live",
};

type OnboardingState = { steps: Record<string, boolean>; dismissed: boolean; completedAt: string | null };
type AnalyticsOverview = {
  totalCalls: number;
  totalMinutes: number;
  callsPerDay?: number[];
  avgConversionRate?: number | null;
};

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

  const data = analytics.data;

  return (
    <div className="page-enter space-y-6">
      <PageHeader
        title="Home"
        description="Live operations across your agents and conversations."
      />

      {/* Setup checklist */}
      {onboarding.isLoading ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : (
        !checklistDone &&
        !onboarding.data?.dismissed && (
          <div className="card-weeber">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <div className="text-sm font-medium">Finish setting up Weeber</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {stepEntries.filter(([, done]) => done).length} of {stepEntries.length || 4} steps done
                </p>
              </div>
              <button
                type="button"
                onClick={dismissChecklist}
                aria-label="Dismiss checklist"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <ul className="space-y-2.5">
                {stepEntries.map(([key, done]) => (
                  <li key={key} className="flex items-center gap-3">
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                        done
                          ? "bg-success/15 text-success"
                          : "border border-border text-transparent"
                      }`}
                    >
                      {done && <Check className="size-3" />}
                    </span>
                    <span
                      className={`text-sm ${
                        done ? "text-muted-foreground line-through" : "text-foreground"
                      }`}
                    >
                      {STEP_LABELS[key] || key}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="outline"
                className="mt-4 gap-1.5"
                onClick={() => setSetupOpen(true)}
              >
                <Sparkles className="size-3.5" />
                Resume setup
              </Button>
            </div>
          </div>
        )
      )}

      {/* Stat tiles */}
      <div className="grid gap-5 sm:grid-cols-3">
        {analytics.isLoading ? (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-weeber h-24 animate-pulse bg-muted/40" />
            ))}
          </>
        ) : (
          <>
            <div className="card-weeber p-5">
              <div className="text-xs text-muted-foreground">Total calls (30d)</div>
              <div className="mt-2 text-3xl font-bold tracking-tight font-mono">
                {data?.totalCalls ?? 0}
              </div>
            </div>
            <div className="card-weeber p-5">
              <div className="text-xs text-muted-foreground">Total minutes (30d)</div>
              <div className="mt-2 text-3xl font-bold tracking-tight font-mono">
                {data?.totalMinutes ?? 0}
              </div>
            </div>
            <div className="card-weeber p-5">
              <div className="text-xs text-muted-foreground">Agents active</div>
              <div className="mt-2 text-3xl font-bold tracking-tight font-mono">
                {/* derived from vertical nav or agent count — show em-dash until wired */}
                —
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Configure on the Agents page.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Quick navigation cards */}
      <div className="grid gap-5 sm:grid-cols-3">
        <Link href={appPath("/agents")}>
          <div className="card-action flex items-start gap-3 p-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Bot className="size-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium">Agents</div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                Configure voice, tone, and tools per agent.
              </p>
            </div>
          </div>
        </Link>
        <Link href={appPath("/calls")}>
          <div className="card-action flex items-start gap-3 p-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <PhoneCall className="size-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium">Conversations</div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                {vertical.copy.callsEmptyBody}
              </p>
            </div>
          </div>
        </Link>
        <Link href={appPath("/analytics")}>
          <div className="card-action flex items-start gap-3 p-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <BarChart3 className="size-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium">Analytics</div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                Latency, tool usage, and outcomes in depth.
              </p>
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
