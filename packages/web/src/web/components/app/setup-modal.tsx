import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader as Loader2, Store, Bot, Rocket, ArrowRight, Phone, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { useUser } from "./user-shell";
import { VERTICAL_OPTIONS, getVertical } from "../../lib/verticals";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Skeleton } from "../ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { cn } from "../../lib/utils";

/**
 * Setup wizard as a modal over the dashboard, not a dedicated page — see
 * docs/DECISIONS.md "Setup modal, not a setup page". Reworked 2026-07-16
 * (explicit user decision) to actually cover what the old 3-step version
 * never did:
 *   1. Pick your business type — was hardcoded `pick_vertical: true` even
 *      though orgs.vertical always silently defaults to "shopify" on
 *      signup and nothing ever asked the user to confirm/correct it. Now a
 *      real first step (STEP_LABELS in home.tsx already said "Pick your
 *      business type" — this was scaffolded but never wired to anything).
 *   2. Connect store — unchanged for verticals with a real integration
 *      (Shopify), but now genuinely SKIPPED for verticals that don't have
 *      one yet (insurance) instead of always being Shopify-shaped
 *      regardless of what was picked.
 *   3. Pick your agents — unchanged.
 *   4. Phone number (NEW) — BYO Twilio is the emphasized/primary path,
 *      platform auto-provisioning is the fallback if they skip BYO. Agents
 *      could previously be turned on with nowhere to actually call from.
 *   5. Review & activate — now vertical/phone-aware.
 *
 * Step completion is mirrored into onboarding_state via PATCH
 * /api/app/onboarding so the dashboard's checklist card (home.tsx) and the
 * "reopen where I left off" behavior both work without re-deriving status
 * from scratch every time. `pick_vertical` and `setup_number` can't be
 * derived from live data the way `hasShop`/`enabledRows.length` can (a
 * vertical/number either exists or doesn't, there's no "confirmed" bit on
 * its own) — so those two are read back from the persisted onboarding
 * state instead, and only flip true once the user actually passes that
 * step in this session.
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

type TelephonyStatus = {
  provider: "twilio" | "plivo" | "exotel";
  outboundNumber: string | null;
  twilio: { mode: "platform" | "byo"; accountSid: string | null; outboundNumber: string | null; usingGlobalDefault: boolean };
};

type OnboardingState = { steps: Record<string, boolean>; dismissed: boolean; completedAt: string | null };

function StepIndicator({ labels, current, done }: { labels: string[]; current: number; done: boolean[] }) {
  const completionPercent = (done.filter(Boolean).length / done.length) * 100;
  return (
    <div className="mb-6 flex items-center gap-2">
      <ol className="flex flex-1 items-center gap-2" aria-label="Setup progress">
        {labels.map((label, i) => {
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
              <span className={cn("text-sm hidden sm:inline", isCurrent ? "font-medium" : "text-muted-foreground")}>{label}</span>
              {i < labels.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden />}
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

/** Phone number step — BYO Twilio is the emphasized primary path (larger
 * card, first), platform auto-provisioning is the smaller fallback below
 * it. Only Twilio BYO here (not Plivo/Exotel) — this is the fast common
 * path for onboarding; the full multi-provider picker lives on the
 * Integrations page for anyone who needs it. Skippable — a number isn't
 * strictly required to finish setup, but skipping leaves it visibly
 * incomplete on the dashboard checklist rather than silently missing. */
function PhoneNumberStep({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [byoForm, setByoForm] = useState({ accountSid: "", authToken: "", phoneNumber: "" });
  const [countryCode, setCountryCode] = useState("US");

  const status = useQuery<{ telephony: TelephonyStatus }>({
    queryKey: ["app-telephony-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/telephony/status");
      if (!res.ok) throw new Error(`status failed (${res.status})`);
      return res.json();
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["app-telephony-status"] });

  const byoMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/byo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(byoForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to connect Twilio");
      return data;
    },
    onSuccess: () => {
      toast.success("Twilio connected");
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const autoProvisionMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to get a number");
      return data as { phoneNumber: string };
    },
    onSuccess: (data) => {
      toast.success(`Got you ${data.phoneNumber}`);
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connected = Boolean(status.data?.telephony?.outboundNumber);

  if (status.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (connected) {
    return (
      <div className="mt-4 space-y-4">
        <p className="flex items-center gap-1.5 text-sm text-success">
          <Check className="size-4" aria-hidden />
          {status.data!.telephony.outboundNumber} is connected
          {status.data!.telephony.twilio.mode === "byo" ? " (your own Twilio account)" : " (assigned automatically)"}.
        </p>
        <Button onClick={onDone}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5">
      <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
        <h3 className="text-sm font-medium">Bring your own Twilio account</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Recommended if you already have one — you keep full control of billing and the number.
        </p>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          <Input
            placeholder="Account SID"
            value={byoForm.accountSid}
            onChange={(e) => setByoForm((f) => ({ ...f, accountSid: e.target.value }))}
          />
          <Input
            placeholder="Auth token"
            type="password"
            value={byoForm.authToken}
            onChange={(e) => setByoForm((f) => ({ ...f, authToken: e.target.value }))}
          />
          <Input
            placeholder="+15551234567"
            value={byoForm.phoneNumber}
            onChange={(e) => setByoForm((f) => ({ ...f, phoneNumber: e.target.value }))}
          />
        </div>
        <Button
          size="sm"
          className="mt-3"
          disabled={!byoForm.accountSid.trim() || !byoForm.authToken.trim() || !byoForm.phoneNumber.trim() || byoMutation.isPending}
          onClick={() => byoMutation.mutate()}
        >
          {byoMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Connect Twilio
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium">Get a number automatically</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          No Twilio account? We'll provision one for you — a real recurring telephony charge applies.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2.5">
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="US">United States</option>
            <option value="IN">India</option>
            <option value="GB">United Kingdom</option>
            <option value="CA">Canada</option>
          </select>
          <Button size="sm" variant="outline" disabled={autoProvisionMutation.isPending} onClick={() => autoProvisionMutation.mutate()}>
            {autoProvisionMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Get me a number
          </Button>
        </div>
      </div>

      <Button variant="ghost" size="sm" onClick={onDone} className="text-muted-foreground">
        Skip for now — I'll do this later on the Phone Numbers page
      </Button>
    </div>
  );
}

export function SetupModal({
  open,
  onOpenChange,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once when the user reaches "You're all set" — parent refetches its own dashboard queries. */
  onFinished?: () => void;
}) {
  const queryClient = useQueryClient();
  const { me } = useUser();
  const [manualStep, setManualStep] = useState<number | null>(null);
  const [pickedVertical, setPickedVertical] = useState(me.org.vertical);
  // Guards the one-shot default provisioning so it fires at most once per open
  // session even as the agents step re-renders.
  const provisionedRef = useRef(false);

  useEffect(() => {
    setPickedVertical(me.org.vertical);
  }, [me.org.vertical]);

  const vertical = getVertical(pickedVertical);

  const onboarding = useQuery<OnboardingState>({
    queryKey: ["app-onboarding"],
    queryFn: async () => {
      const res = await appFetch("/api/app/onboarding");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: open,
  });

  const status = useQuery({
    queryKey: ["app-shopify-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/shopify/status");
      if (!res.ok) throw new Error(`status failed (${res.status})`);
      return (await res.json()) as ShopifyStatus;
    },
    enabled: open && vertical.hasLiveIntegration,
    refetchInterval: (query) => (open && vertical.hasLiveIntegration && !query.state.data?.hasShop ? 5000 : false),
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

  const telephonyStatus = useQuery<{ telephony: TelephonyStatus }>({
    queryKey: ["app-telephony-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/telephony/status");
      if (!res.ok) throw new Error(`status failed (${res.status})`);
      return res.json();
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

  const saveVertical = useMutation({
    mutationFn: async (next: string) => {
      const res = await appFetch("/api/app/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vertical: next }),
      });
      if (!res.ok) throw new Error(`Failed to save (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      patchOnboarding.mutate({ pick_vertical: true });
    },
    onError: (err: Error) => toast.error("Couldn't save business type", { description: err.message }),
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

  // One-shot auto-provisioning of the vertical's recommended default agents +
  // workflow (2026-07-19). Fired once when the merchant first reaches the
  // "Pick agents" step so the recommended toggles are already ON instead of
  // every agent shipping off (the old behavior let a merchant finish setup
  // with nothing that would ever place a call). Idempotent + non-destructive
  // server-side, so re-firing never re-enables something they turned off.
  const provisionDefaults = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/provision-defaults", { method: "POST" });
      if (!res.ok) throw new Error(`provision failed (${res.status})`);
      return (await res.json()) as { vertical: string; agentsEnabled: string[]; workflowsEnabled: string[] };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      queryClient.invalidateQueries({ queryKey: ["app-shopify-status"] });
    },
  });

  const rows = configs.data?.agentConfigs ?? [];
  const enabledRows = rows.filter((r) => r.config?.enabled);
  const hasShop = status.data?.hasShop ?? false;
  const hasNumber = Boolean(telephonyStatus.data?.telephony?.outboundNumber);

  // Persisted flags for steps that can't be derived from live data alone.
  const verticalConfirmed = onboarding.data?.steps?.pick_vertical === true;
  const numberStepDone = onboarding.data?.steps?.setup_number === true || hasNumber;

  // Dynamic step list — "Connect store" only exists for verticals with a
  // real integration (see VerticalDefinition.hasLiveIntegration's doc comment).
  const stepKeys = useMemo(
    () => (["vertical", vertical.hasLiveIntegration ? "connect" : null, "agents", "number", "review"].filter(Boolean) as string[]),
    [vertical.hasLiveIntegration],
  );
  const stepLabels = stepKeys.map((k) =>
    k === "vertical"
      ? "Business type"
      : k === "connect"
        ? "Connect store"
        : k === "agents"
          ? "Pick agents"
          : k === "number"
            ? "Phone number"
            : "Review & activate",
  );
  const stepDone = stepKeys.map((k) =>
    k === "vertical"
      ? verticalConfirmed
      : k === "connect"
        ? hasShop
        : k === "agents"
          ? enabledRows.length > 0
          : k === "number"
            ? numberStepDone
            : verticalConfirmed && (vertical.hasLiveIntegration ? hasShop : true) && enabledRows.length > 0,
  );
  const firstIncomplete = stepDone.findIndex((d) => !d);
  const current = manualStep ?? (firstIncomplete === -1 ? stepKeys.length - 1 : firstIncomplete);
  const currentKey = stepKeys[current];

  function goNext() {
    setManualStep(Math.min(current + 1, stepKeys.length - 1));
  }
  function goBack() {
    setManualStep(Math.max(current - 1, 0));
  }

  // Mirror step completion server-side as it happens, so the dashboard
  // checklist card and "resume setup" state stay accurate even if the
  // user closes the modal mid-way. pick_vertical/setup_number are patched
  // explicitly elsewhere (saveVertical's onSuccess, PhoneNumberStep's
  // onDone) since they can't be derived from live data the way these two can.
  useEffect(() => {
    if (!open) return;
    patchOnboarding.mutate({
      connect_tools: vertical.hasLiveIntegration ? hasShop : true,
      create_agent: enabledRows.length > 0,
      test_and_golive: verticalConfirmed && (vertical.hasLiveIntegration ? hasShop : true) && enabledRows.length > 0 && numberStepDone,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasShop, enabledRows.length, vertical.hasLiveIntegration, verticalConfirmed, numberStepDone]);

  // Reset the provisioning guard whenever the modal closes so a later reopen
  // can re-run the (idempotent) provisioning for the current vertical.
  useEffect(() => {
    if (!open) provisionedRef.current = false;
  }, [open]);

  // Auto-provision the recommended default agents + workflow the moment the
  // merchant first lands on the "Pick agents" step, so the recommended
  // toggles render already ON. Waits until the configs query has loaded so we
  // don't race the invalidation, and only fires once per open session.
  useEffect(() => {
    if (!open || currentKey !== "agents" || provisionedRef.current) return;
    if (configs.isLoading || provisionDefaults.isPending) return;
    provisionedRef.current = true;
    provisionDefaults.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentKey, configs.isLoading]);

  const isLoading = onboarding.isLoading || configs.isLoading || (vertical.hasLiveIntegration && status.isLoading);

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
            <StepIndicator labels={stepLabels} current={current} done={stepDone} />

            {currentKey === "vertical" && (
              <div key="step-vertical" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">What kind of business is this?</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      This decides which agents, dashboard metrics, and terminology you see everywhere else in
                      Weeber — you can change it later in Settings.
                    </p>
                    <div className="mt-5 space-y-2.5">
                      {VERTICAL_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setPickedVertical(opt.key)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors",
                            pickedVertical === opt.key
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/50",
                          )}
                        >
                          <opt.icon className={cn("mt-0.5 size-4 shrink-0", pickedVertical === opt.key ? "text-primary" : "text-muted-foreground")} aria-hidden />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">{opt.label}</span>
                            <span className="block text-xs text-muted-foreground">{opt.description}</span>
                          </span>
                          {pickedVertical === opt.key && <Check className="ml-auto size-4 shrink-0 text-primary" aria-hidden />}
                        </button>
                      ))}
                    </div>
                    <Button
                      className="mt-5"
                      disabled={saveVertical.isPending}
                      onClick={() => {
                        if (pickedVertical === me.org.vertical) {
                          // Unchanged — still confirm the step without a wasted PATCH.
                          patchOnboarding.mutate({ pick_vertical: true });
                        } else {
                          saveVertical.mutate(pickedVertical);
                        }
                        goNext();
                      }}
                    >
                      {saveVertical.isPending && <Loader2 className="size-3.5 animate-spin" />}
                      Continue
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {currentKey === "connect" && (
              <div key="step-connect" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <Store className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">{vertical.copy.onboardingConnectTitle}</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">{vertical.copy.onboardingConnectBody}</p>
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
                      <Button className="mt-5" onClick={goNext}>
                        Continue
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {currentKey === "agents" && (
              <div key="step-agents" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <Bot className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">Your agents</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      We've already turned on the recommended agents for your business — each comes ready to
                      work with sensible defaults. Toggle any off, or turn on the rest, and fine-tune voice,
                      tone, and script on the Agents page any time.
                    </p>
                    <div className="mt-5 space-y-3">
                      {rows.length === 0 && (
                        <p className="text-sm text-muted-foreground">No agent templates available for your business type yet.</p>
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
                      <Button variant="outline" onClick={goBack}>
                        Back
                      </Button>
                      <Button onClick={goNext} disabled={enabledRows.length === 0}>
                        Continue
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {currentKey === "number" && (
              <div key="step-number" className="slide-in-right">
                <div className="flex items-start gap-3">
                  <Phone className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">Give your agents a phone number</h2>
                    <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                      Without one, an enabled agent has nothing to call from or receive calls on.
                    </p>
                    <PhoneNumberStep
                      onDone={() => {
                        patchOnboarding.mutate({ setup_number: true });
                        goNext();
                      }}
                    />
                    <Button variant="outline" className="mt-3" onClick={goBack}>
                      Back
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {currentKey === "review" && (
              <div key="step-review" className="slide-in-right relative">
                <div className="flex items-start gap-3">
                  <Rocket className="mt-0.5 size-5 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium">You're all set</h2>
                    <dl className="mt-4 space-y-2 text-sm">
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Business type:</dt>
                        <dd>{VERTICAL_OPTIONS.find((o) => o.key === vertical.key)?.label ?? vertical.key}</dd>
                      </div>
                      {vertical.hasLiveIntegration && (
                        <div className="flex gap-2">
                          <dt className="text-muted-foreground">Store:</dt>
                          <dd className="font-mono">
                            {status.data?.shops.find((s) => !s.disconnectedAt)?.shop ?? "not connected"}
                          </dd>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Active agents:</dt>
                        <dd>{enabledRows.map((r) => r.templateName).join(", ") || "none"}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Phone number:</dt>
                        <dd className="font-mono">{telephonyStatus.data?.telephony?.outboundNumber ?? "not connected yet"}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 max-w-xl text-sm text-muted-foreground">
                      Your agents now react to events automatically — there's nothing to deploy or schedule.
                      Conversations and results will appear on your dashboard as they happen.
                    </p>
                    <div className="mt-5 flex gap-3">
                      <Button variant="outline" onClick={goBack}>
                        Back
                      </Button>
                      <Button
                        onClick={() => {
                          patchOnboarding.mutate({ test_and_golive: true });
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
