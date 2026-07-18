import { Phone, ShieldCheck, PackageCheck, RotateCcw, MessageSquare, Zap } from "lucide-react";
import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SectionHeading } from "../components/marketing/SectionHeading";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { AgentDemoWidget } from "../components/marketing/AgentDemoWidget";

const LEAK_STATS = [
  { value: "~70%", label: "of online carts are abandoned before checkout" },
  { value: "~10%", label: "typical open rate on abandoned-cart recovery emails" },
  { value: "COD RTO", label: "unconfirmed cash-on-delivery orders drive return-to-origin losses across Indian D2C" },
] as const;

const FLOWS = [
  {
    icon: RotateCcw,
    title: "Abandoned cart recovery",
    body: "Weeber calls every abandoned cart automatically and offers a discount code to bring the checkout back to life. WhatsApp checkout links are on the roadmap.",
  },
  {
    icon: PackageCheck,
    title: "COD confirmation",
    body: "Confirms cash-on-delivery orders before they ship — cuts return-to-origin losses instead of finding out at the doorstep.",
  },
  {
    icon: MessageSquare,
    title: "Order & shipping updates",
    body: "Automatic calls at every step — placed, shipped, out for delivery — so support isn't fielding \"where's my order\" calls.",
  },
  {
    icon: Phone,
    title: "Review & feedback calls",
    body: "A short call after delivery captures feedback while it's fresh, without a survey link nobody clicks.",
  },
] as const;

const SETUP_STEPS = [
  { step: "01", title: "Install", body: "One-click Shopify OAuth — no code, no dev time." },
  { step: "02", title: "Pick a flow template", body: "Cart recovery, COD confirmation, or both — pre-built, not built from scratch." },
  { step: "03", title: "Go live", body: "Your agent starts calling within the hour." },
] as const;

export function ShopifySolutionPage() {
  usePageMeta({
    title: "AI Voice Agent for Shopify — Abandoned Cart Recovery & COD Confirmation",
    description:
      "Weeber calls every abandoned Shopify cart, confirms COD orders, and sends order/shipping updates — automatically, compliance-checked, live in an afternoon.",
    path: "/shopify",
  });

  return (
    <MarketingPageShell>
      {/* Hero */}
      <section className="relative pt-32 pb-20 px-6 text-center overflow-hidden border-b border-[var(--m-border)]">
        <div className="relative z-10 max-w-[900px] mx-auto">
          <span data-reveal className="inline-flex items-center gap-2 border border-[var(--m-text)] rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold mb-6">
            <Zap className="w-3.5 h-3.5" aria-hidden />
            Flagship vertical — launching first
          </span>
          <h1 data-reveal className="font-display text-[clamp(2.4rem,5.5vw,4.6rem)] font-extrabold leading-[0.98] tracking-[-0.03em] text-[var(--m-text)]">
            Recover the carts
            <br /> your emails can't.
          </h1>
          <p data-reveal className="mt-6 text-[1.1rem] font-medium text-[var(--m-text-secondary)] max-w-[560px] mx-auto leading-[1.6]">
            Weeber calls every abandoned cart, confirms COD orders, and sends shipping updates — automatically,
            for your Shopify store. No code, live in an afternoon.
          </p>
          <div data-reveal className="mt-10">
            <WaitlistForm source="shopify-solution" />
          </div>
        </div>
      </section>

      {/* The leak, quantified */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="The e-commerce leak" title="Every one of these is revenue you already earned." align="center" />
          <div className="mt-14 grid md:grid-cols-3 gap-8" data-reveal>
            {LEAK_STATS.map((s) => (
              <div key={s.label} className="text-center">
                <span className="block font-display font-extrabold text-[clamp(28px,3.5vw,40px)] leading-none tracking-[-0.03em] text-[var(--m-text)]">{s.value}</span>
                <p className="mt-3 text-sm text-[var(--m-text-secondary)] leading-relaxed max-w-[240px] mx-auto">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What Weeber does for a store */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="What Weeber does for your store" title="Four flows, built for Shopify, ready on day one." />
          <div className="mt-12 grid md:grid-cols-2 gap-px bg-[var(--m-border)] border border-[var(--m-border)] overflow-hidden" data-reveal>
            {FLOWS.map((flow) => (
              <div key={flow.title} className="p-8 bg-[var(--m-bg)]">
                <flow.icon className="w-5 h-5 text-[var(--m-text)] mb-4" aria-hidden />
                <h3 className="font-display font-bold text-[var(--m-text)] mb-2 text-[17px]">{flow.title}</h3>
                <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed">{flow.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Live demo */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Hear it for yourself" title="Real calls, real outcomes." align="center" />
          <div className="mt-12" data-reveal>
            <AgentDemoWidget />
          </div>
        </div>
      </section>

      {/* Compliance for e-commerce */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <div className="grid md:grid-cols-[1fr_1.2fr] gap-12 items-center">
            <div data-reveal>
              <ShieldCheck className="w-10 h-10 text-[var(--m-text)] mb-5" aria-hidden />
              <span className="font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">Compliance for e-commerce</span>
              <h2 className="mt-4 font-display text-[clamp(26px,3.2vw,38px)] font-extrabold tracking-[-0.03em] leading-[1.06] text-[var(--m-text)]">
                Consent-gated, so you don't get fined for recovering revenue.
              </h2>
            </div>
            <div data-reveal className="space-y-4">
              <p className="text-[15.5px] text-[var(--m-text-secondary)] leading-relaxed">
                Every number is checked against your consent records before Weeber can dial it — opt-outs and DND/DNC
                lists are enforced automatically, not left to a spreadsheet someone forgets to update.
              </p>
              <p className="text-[15.5px] text-[var(--m-text-secondary)] leading-relaxed">
                A $12,000 TCPA fine is what happens when a cart-recovery campaign skips this step. Weeber makes that
                mistake structurally impossible — the call simply doesn't happen without consent on file.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Setup in an afternoon */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Setup" title="Live in an afternoon, not a sprint." align="center" />
          <div className="mt-12 grid md:grid-cols-3 gap-px bg-[var(--m-border)] border border-[var(--m-border)] overflow-hidden" data-reveal>
            {SETUP_STEPS.map((s, i) => (
              <div key={s.step} className={`p-8 bg-[var(--m-bg)] text-center ${i < SETUP_STEPS.length - 1 ? "border-b md:border-b-0 md:border-r border-[var(--m-border)]" : ""}`}>
                <div className="font-mono text-xs text-[var(--m-text-muted)] mb-4">{s.step}</div>
                <h3 className="font-display font-bold text-[var(--m-text)] mb-2 text-[17px]">{s.title}</h3>
                <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Stop leaking revenue to unanswered calls.
          </h2>
          <p className="mt-4 text-[16px] text-[var(--m-text-secondary)]">First 100 stores lock in founder pricing for life.</p>
          <div className="mt-8">
            <WaitlistForm source="shopify-solution-footer" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
