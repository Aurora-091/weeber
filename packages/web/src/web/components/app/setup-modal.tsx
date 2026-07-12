import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader as Loader2, Store, Bot, Rocket, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/merchant-session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Skeleton } from "../ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { cn } from "../../lib/utils";

/**
 * Setup wizard as a modal over the dashboard, not a dedicated page — see
 * docs/DECISIONS.md "Setup modal, not a setup page". Ported from the old
 * full-page pages/app/onboarding.tsx (now removed); same 3 steps, same
 * copy, same mutations — only the shell changed (Dialog instead of a route).
 *
 * Step completion is also mirrored into onboarding_state via PATCH
 * /api/app/onboarding so the dashboard's checklist card (setup-checklist.tsx)
 * and the "reopen where I left off" behavior both work without re-deriving
 * status from scratch every time.
 */

type ShopifyStatus = {
  shops: { shop: string; connectedAt: string; disconnectedAt: string | null }[];
  hasShop: boolean;
  enabledAgentCount: number;
  installUrl: string | null;
};

type AgentConfigRow = {
  templateKey: string;
  templateName: string;
  templateDescription: string | null;
  config: { enabled: boolean } | null;
};

const STEPS = ["Connect store", "Pick your agents", "Review & activate"] as const;

function StepIndicator({ current, done }: { current: number; done: boolean[] }) {
  const completionPercent = (done.filter(Boolean).length / done.length) * 100;
  return (
    <div className="mb-6 flex items-center gap-2">
      <ol className="flex flex-1 items-center gap-2" aria-label="Setup progress">
        {STEPS.map((label, i) => {
          const isDone = done[i];
          const isCurrent = i === current;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  isDone
                    ? "bg-success text-primary-foreground"
                    : isCurrent
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                {isDone ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={cn("text-sm", isCurrent ? "font-medium" : "text-muted-foreground")}>{label}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>
      <span className="ml-auto text-xs font-mono text-muted-foreground">{Math.round(completionPercent)}%</span>
    </div>
  );
}

function ShopifyInstallForm() {
  const [storeDomain, setStoreDomain] = useState("");

  const installMutation = useMutation({
    mutationFn: async (shop: string) => {
      const res = await appFetch("/api/app/shopify/install-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to generate install URL" }));
        throw new Error(err.error ?? "Failed to generate install URL");
      }
      return res.json() as Promise<{ installUrl: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.installUrl;
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const domain = storeDomain.trim();
    if (!domain) return;
    installMutation.mutate(domain);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-5 space-y-3">
      <label htmlFor="ob-store-domain" className="text-xs font-medium text-muted-foreground">
        Your Shopify store domain
      </label>
      <div className="flex items-center gap-1.5 text-sm">
        <Store className="size-4 text-[#96bf48]" aria-hidden />
        <span className="font-medium text-muted-foreground">Shopify</span>
      </div>
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Input
            id="ob-store-domain"
            placeholder="your-store"
            value={storeDomain}
            onChange={(e) => setStoreDomain(e.target.value)}
            className="pr-32"
            disabled={installMutation.isPending}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
            .myshopify.com
          </span>
        </div>
        <Button type="submit" disabled={!storeDomain.trim() || installMutation.isPending} className="gap-1.5">
          {installMutation.isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Redirecting...
            </>
          ) : (
            <>
              Install on Shopify
              <ArrowRight className="size-3.5" />
            </>
          )}
        </Button>
      </div>
      {installMutation.isError && <p className="text-xs text-destructive">{installMutation.error.message}</p>}
    </form>
  );
}

export function SetupModal({
  open,
  onOpenChange,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once when the merchant reaches "You're all set" — parent refetches its own dashboard queries. */
  onFinished?: () => void;
}) {
  const queryClient = useQueryClient();
  const [manualStep, setManualStep] = useState<number | null>(null);

  const status = useQuery({
    queryKey: ["app-shopify-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/shopify/status");
      if (!res.ok) throw new Error(`status failed (${res.status})`);
      return (await res.json()) as ShopifyStatus;
    },
    enabled: open,
    refetchInterval: (query) => (open && !query.state.data?.hasShop ? 5000 : false),
  });

  const configs = useQuery({
    queryKey: ["app-agent-configs"],
    queryFn: async () => {
      const res = await appFetch("/api/app/agent-configs");
      if (!res.ok) throw new Error(`configs failed (${res.status})`);
      return (await res.json()) as { agentConfigs: AgentConfigRow[] };
    },
    enabled: open,
  });

  const patchOnboarding = useMutation({
    mutationFn: async (steps: Record<string, boolean>) => {
      const res = await appFetch("/api/app/onboarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
      });
      if (!res.ok) throw new Error(`onboarding patch failed (${res.status})`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["app-onboarding"] }),
  });

  const toggleAgent = useMutation({
    mutationFn: async ({ templateKey, enabled }: { templateKey: string; enabled: boolean }) => {
      const res = await appFetch(`/api/app/agent-configs/${encodeURIComponent(templateKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      return res.json();
    },
    onSuccess: (_data, { templateKey, enabled }) => {
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      queryClient.invalidateQueries({ queryKey: ["app-shopify-status"] });
      toast.success(enabled ? `${templateKey} enabled` : `${templateKey} disabled`);
    },
    onError: (err: Error) => {
      toast.error("Couldn't toggle agent", { description: err.message });
    },
  });

  const rows = configs.data?.agentConfigs ?? [];
  const enabledRows = rows.filter((r) => r.config?.enabled);
  const hasShop = status.data?.hasShop ?? false;

  const stepDone = [hasShop, enabledRows.length > 0, hasShop && enabledRows.length > 0];
  const firstIncomplete = stepDone[0] ? (stepDone[1] ? 2 : 1) : 0;
  const current = manualStep ?? firstIncomplete;

  // Mirror step completion server-side as it happens, so the dashboard
  // checklist card and "resume setup" state stay accurate even if the
  // merchant closes the modal mid-way.
  useEffect(() => {
    if (!open) return;
    patchOnboarding.mutate({
      pick_vertical: true, // only one vertical exists today — nothing to pick yet, always satisfied
      connect_tools: hasShop,
      create_agent: enabledRows.length > 0,
      test_and_golive: hasShop && enabledRows.length > 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasShop, enabledRows.length]);

  const isLoading = status.isLoading || configs.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Set up Weeber</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <StepIndicator current={current} done={stepDone} />

            {current === 0 && (
              <div key="step-0" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <Store className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">Connect your Shopify store</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      Install the Weeber app on your store so your agents can react to checkouts, orders, and
                      fulfillments.
                    </p>
                    {hasShop ? (
                      <p className="mt-4 flex items-center gap-1.5 text-sm text-success">
                        <Check className="size-4" aria-hidden />
                        {status.data!.shops.find((s) => !s.disconnectedAt)?.shop} is connected.
                      </p>
                    ) : (
                      <ShopifyInstallForm />
                    )}
                    {!hasShop && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        This checks automatically every few seconds after you install.
                      </p>
                    )}
                    {hasShop && (
                      <Button className="mt-5" onClick={() => setManualStep(1)}>
                        Continue
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {current === 1 && (
              <div key="step-1" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <Bot className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">Pick your agents</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      Turn on the agents you want. Each comes ready to work with sensible defaults — you can
                      fine-tune voice, tone, and script on the Agents page any time.
                    </p>
                    <div className="mt-5 space-y-3">
                      {rows.length === 0 && (
                        <p className="text-sm text-muted-foreground">No agent templates available for your store type yet.</p>
                      )}
                      {rows.map((row) => (
                        <div
                          key={row.templateKey}
                          className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{row.templateName}</div>
                            {row.templateDescription && (
                              <div className="mt-0.5 text-xs text-muted-foreground">{row.templateDescription}</div>
                            )}
                          </div>
                          <Switch
                            checked={row.config?.enabled ?? false}
                            disabled={toggleAgent.isPending}
                            onCheckedChange={(enabled) => toggleAgent.mutate({ templateKey: row.templateKey, enabled })}
                            aria-label={`Enable ${row.templateName}`}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-5 flex gap-3">
                      <Button variant="outline" onClick={() => setManualStep(0)}>
                        Back
                      </Button>
                      <Button onClick={() => setManualStep(2)} disabled={enabledRows.length === 0}>
                        Continue
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {current === 2 && (
              <div key="step-2" className="slide-in-right relative">
                <div className="flex items-start gap-3">
                  <Rocket className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">You're all set</h2>
                    <dl className="mt-4 space-y-2 text-sm">
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Store:</dt>
                        <dd className="font-mono">
                          {status.data?.shops.find((s) => !s.disconnectedAt)?.shop ?? "not connected"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Active agents:</dt>
                        <dd>{enabledRows.map((r) => r.templateName).join(", ") || "none"}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 max-w-xl text-sm text-muted-foreground">
                      Your agents now react to store events automatically — there's nothing to deploy or schedule.
                      Conversations and results will appear as they happen.
                    </p>
                    <div className="mt-5 flex gap-3">
                      <Button variant="outline" onClick={() => setManualStep(1)}>
                        Back
                      </Button>
                      <Button
                        onClick={() => {
                          onOpenChange(false);
                          onFinished?.();
                        }}
                      >
                        Go to dashboard
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
