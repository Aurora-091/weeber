import { useQuery } from "@tanstack/react-query";
import { CreditCard, Phone, Clock, ShieldCheck, Check } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";

type BillingUsage = {
  rangeDays: number;
  planName: string | null;
  currency: string | null;
  calls: number;
  minutes: number;
  gateway: null;
};

function getPlanLimit(plan: string): number {
  switch (plan.toLowerCase()) {
    case "starter":
      return 100;
    case "pro":
      return 500;
    case "enterprise":
      return 999999;
    default:
      return 500;
  }
}

function getDaysUntilReset(): number {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const diff = nextMonth.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function UserBillingPage() {
  const { me } = useUser();

  const usageQuery = useQuery<BillingUsage>({
    queryKey: ["app-billing-usage", me.org.id],
    queryFn: async () => {
      const res = await appFetch("/api/app/billing/usage");
      if (!res.ok) throw new Error(`billing usage failed (${res.status})`);
      return res.json();
    },
  });

  const usage = usageQuery.data;
  const plan = usage?.planName || "Free Trial";
  const limit = getPlanLimit(plan);
  const percentage = Math.min(100, limit > 0 ? (usage?.minutes ?? 0) / limit * 100 : 0);
  const daysLeft = getDaysUntilReset();

  const tiers = [
    {
      name: "Starter",
      price: "$19",
      period: "month",
      description: "Perfect for growing stores getting started with voice recovery.",
      features: ["Up to 100 call minutes/month", "Standard voice models", "Default Shopify recovery agents", "Email support"],
      current: plan.toLowerCase() === "starter",
    },
    {
      name: "Pro",
      price: "$79",
      period: "month",
      description: "Ideal for high-volume stores needing robust customization.",
      features: ["Up to 500 call minutes/month", "Advanced voice models (Cartesia/ElevenLabs)", "Custom prompt frame tailoring", "Priority email & chat support"],
      current: plan.toLowerCase() === "pro" || plan.toLowerCase() === "default" || plan === "Free Trial",
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      description: "For large scale brands requiring custom volumes and compliance SLA.",
      features: ["Unlimited call minutes", "Custom SLA & dedicated support", "Custom compliance limits", "Dedicated numbers & sub-accounts"],
      current: plan.toLowerCase() === "enterprise",
    },
  ];

  return (
    <div className="space-y-8 font-sans text-foreground bg-background page-enter">
      <PageHeader
        title="Billing & Plan"
        description="Monitor your call volumes, usage limits, and active subscription details."
      />

      {usageQuery.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading billing info…
        </div>
      )}

      {usage && (
        <div className="grid gap-6 sm:grid-cols-3 content-fade-in">
          {/* Current Subscription Card */}
          <div className="rounded-lg border border-border bg-card p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <CreditCard className="size-3.5" />
                Active Subscription
              </div>
              <h2 className="text-2xl font-bold tracking-tight mt-1">{plan}</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Your plan is currently active. Billing cycles renew monthly.
              </p>
              <p className="text-xs text-muted-foreground mt-2">Cycle resets in {daysLeft} days</p>
            </div>
            <div className="mt-4 pt-4 border-t border-border flex items-center gap-1.5 text-xs text-success">
              <ShieldCheck className="size-3.5" />
              Active & Compliant
            </div>
          </div>

          {/* Calls Executed Card */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Phone className="size-3.5" />
              Calls Made (Last 30 Days)
            </div>
            <h2 className="text-2xl font-bold tracking-tight mt-1">{usage.calls}</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Successful outbound dials across all active workflows.
            </p>
          </div>

          {/* Call Minutes Card */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="size-3.5" />
              Usage Minutes (Last 30 Days)
            </div>
            <h2 className="text-2xl font-bold tracking-tight mt-1">{usage.minutes} mins</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Aggregated live session duration (rounded to the nearest decimal).
            </p>
            <div className="mt-3">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: percentage + '%' }} />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{usage.minutes} used</span>
                <span>{limit} limit</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plans Section */}
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-medium">Subscription Tiers</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Choose the volume and customization options that fit your store.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-3 content-fade-in">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-lg border p-5 flex flex-col justify-between transition-all duration-200 hover:-translate-y-1 hover:shadow-md hover:border-foreground/15 ${
                tier.current ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border bg-card"
              }`}
            >
              {tier.name === "Pro" && (
                <span className="absolute -top-2.5 right-4 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-medium text-primary-foreground">Recommended</span>
              )}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">{tier.name}</h3>
                  {tier.current && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary uppercase">
                      Current Plan
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-3xl font-bold tracking-tight">{tier.price}</span>
                  {tier.period && <span className="text-xs text-muted-foreground">/{tier.period}</span>}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{tier.description}</p>
                <ul className="mt-4 space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                  {tier.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-2">
                      <Check className="size-3.5 text-primary shrink-0" />
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-6 pt-4">
                <Button
                  className="w-full text-xs font-medium"
                  variant={tier.current ? "outline" : "default"}
                  disabled={tier.current}
                >
                  {tier.current ? "Active" : tier.price === "Custom" ? "Contact sales" : "Upgrade"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
