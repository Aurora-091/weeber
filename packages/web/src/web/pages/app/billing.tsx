import { useQuery } from "@tanstack/react-query";
import { CreditCard, Phone, Clock, ShieldCheck, Check, Mail } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

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
    case "starter": return 100;
    case "pro": return 500;
    case "enterprise": return 999999;
    default: return 500;
  }
}

function getDaysUntilReset(): number {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil((nextMonth.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
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
  const percentage = Math.min(100, limit > 0 ? ((usage?.minutes ?? 0) / limit) * 100 : 0);
  const daysLeft = getDaysUntilReset();

  const tiers = [
    {
      name: "Starter",
      price: "₹999",
      period: "month",
      description: "For growing stores just getting started with voice recovery.",
      features: [
        "Up to 100 call minutes / month",
        "Standard voice models",
        "Default Shopify recovery agents",
        "Email support",
      ],
      isCurrent: plan.toLowerCase() === "starter",
      cta: "Upgrade to Starter",
    },
    {
      name: "Pro",
      price: "₹3,999",
      period: "month",
      description: "For high-volume stores needing advanced customization.",
      features: [
        "Up to 500 call minutes / month",
        "Premium voices (Cartesia / ElevenLabs)",
        "Custom prompt & persona tailoring",
        "Priority email & chat support",
      ],
      isCurrent:
        plan.toLowerCase() === "pro" ||
        plan.toLowerCase() === "default" ||
        plan === "Free Trial",
      cta: "Upgrade to Pro",
      recommended: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      description: "For large brands needing custom volumes, SLA, and compliance.",
      features: [
        "Unlimited call minutes",
        "Dedicated numbers & sub-accounts",
        "Custom compliance SLA",
        "Dedicated support & onboarding",
      ],
      isCurrent: plan.toLowerCase() === "enterprise",
      cta: "Contact us",
    },
  ];

  return (
    <div className="space-y-8 page-enter">
      <PageHeader
        title="Billing & Plan"
        description="Monitor your call volumes, usage limits, and active subscription."
      />

      {usageQuery.isLoading && (
        <div className="grid gap-5 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-weeber h-36 animate-pulse bg-muted/40" />
          ))}
        </div>
      )}

      {usage && (
        <div className="grid gap-5 sm:grid-cols-3 content-fade-in">
          {/* Active plan card */}
          <div className="card-weeber flex flex-col justify-between p-5">
            <div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <CreditCard className="size-3.5" />
                Active Plan
              </div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">{plan}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Billing cycles renew monthly · resets in {daysLeft}d
              </p>
            </div>
            <div className="mt-5 flex items-center gap-1.5 text-xs text-success border-t border-border pt-4">
              <ShieldCheck className="size-3.5" />
              Active & compliant
            </div>
          </div>

          {/* Calls card */}
          <div className="card-weeber p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Phone className="size-3.5" />
              Calls made (last 30d)
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight">{usage.calls}</h2>
            <p className="mt-1 text-xs text-muted-foreground">Successful outbound dials.</p>
          </div>

          {/* Minutes card */}
          <div className="card-weeber p-5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="size-3.5" />
              Usage (last 30d)
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight">{usage.minutes} min</h2>
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-700"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                <span>{usage.minutes} used</span>
                <span>{limit === 999999 ? "Unlimited" : `${limit} limit`}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pricing tiers */}
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">Subscription tiers</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Choose the volume that fits your store.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-3 content-fade-in">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={cn(
                "card-weeber relative flex flex-col justify-between p-5",
                tier.isCurrent && "ring-2 ring-primary/30",
              )}
            >
              {tier.recommended && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground whitespace-nowrap">
                  Recommended
                </span>
              )}

              <div>
                <div className="flex items-start justify-between">
                  <h3 className="font-semibold">{tier.name}</h3>
                  {tier.isCurrent && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                      Current
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-3xl font-bold tracking-tight">{tier.price}</span>
                  {tier.period && (
                    <span className="text-xs text-muted-foreground">/{tier.period}</span>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{tier.description}</p>
                <ul className="mt-4 space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                  {tier.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-2">
                      <Check className="size-3.5 shrink-0 text-success" />
                      {feat}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6">
                {tier.isCurrent ? (
                  <Button className="w-full text-xs font-medium" variant="outline" disabled>
                    Active plan
                  </Button>
                ) : tier.name === "Enterprise" ? (
                  <Button
                    className="w-full text-xs font-medium gap-1.5"
                    variant="outline"
                    asChild
                  >
                    <a href="mailto:hello@weeber.ai?subject=Enterprise enquiry">
                      <Mail className="size-3.5" />
                      {tier.cta}
                    </a>
                  </Button>
                ) : (
                  <Button
                    className="w-full text-xs font-medium gap-1.5"
                    variant="outline"
                    asChild
                  >
                    <a href="mailto:hello@weeber.ai?subject=Upgrade to {tier.name}">
                      {tier.cta}
                    </a>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
