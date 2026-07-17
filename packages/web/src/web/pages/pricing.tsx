import { Check } from "lucide-react";
import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SectionHeading } from "../components/marketing/SectionHeading";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { PRICING_TIERS, PRICING_INCLUDED, COMPARISON_TABLE } from "../lib/marketing-config";

const PRICING_FAQ = [
  { q: "What happens after the founder cohort fills up?", a: "Founder pricing is locked in for life for the first 100 customers — everyone after that sees standard pricing, set at launch." },
  { q: "Are there overages?", a: "Plans are capped by call volume; if you go over, you'll be prompted to upgrade rather than getting silently charged per-minute." },
  { q: "Which currencies do you support?", a: "INR and USD at launch, with India-first payment methods (UPI, cards) supported directly." },
  { q: "Is there a refund policy?", a: "Full refund policy ships with public pricing at launch — reach out any time before then and we'll sort it out directly." },
] as const;

export function PricingPage() {
  usePageMeta({
    title: "Weeber Pricing — Simple, No Rev-Share Voice AI for SMBs",
    description:
      "Founder pricing for the first 100 Weeber customers, locked for life. Simple flat tiers, no revenue-share tax on recovered carts — see the plan shapes and what's included on every tier.",
    path: "/pricing",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <span data-reveal className="inline-flex items-center gap-2 border border-[var(--m-text)] rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold mb-6">
            <span className="w-[7px] h-[7px] rounded-full bg-[var(--m-text)] animate-pulse" />
            Founder pricing for the first 100
          </span>
          <h1 data-reveal className="font-display text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[1.0] tracking-[-0.03em] text-[var(--m-text)]">
            Simple pricing. No rev-share tax on your recovered sales.
          </h1>
          <p data-reveal className="mt-5 text-[1.05rem] text-[var(--m-text-secondary)] max-w-[520px] mx-auto leading-[1.6]">
            Full public pricing is set at launch. Waitlist customers lock in founder rates for life — the tiers
            below show the shape of what's coming.
          </p>
        </div>
      </section>

      {/* Tiers */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <div className="grid md:grid-cols-3 gap-6" data-reveal>
            {PRICING_TIERS.map((tier) => (
              <div
                key={tier.name}
                className={`p-8 rounded-2xl border bg-[var(--m-bg)] flex flex-col ${
                  "highlighted" in tier && tier.highlighted
                    ? "border-[var(--m-text)] shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
                    : "border-[var(--m-border)]"
                }`}
              >
                {"highlighted" in tier && tier.highlighted && (
                  <span className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--m-text)] text-[var(--m-bg)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide">
                    Most popular
                  </span>
                )}
                <h3 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-[var(--m-text)]">{tier.name}</h3>
                <p className="mt-1 text-[13px] font-medium text-[var(--m-text-muted)] uppercase tracking-wide">{tier.audience}</p>
                <p className="mt-4 text-[15px] text-[var(--m-text-secondary)] leading-relaxed">{tier.description}</p>
                <ul className="mt-6 space-y-3 flex-1">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[14px] text-[var(--m-text-secondary)]">
                      <Check className="w-4 h-4 text-[var(--m-text)] shrink-0 mt-0.5" aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href="#waitlist"
                  className={`mt-8 block text-center px-5 py-3 rounded-lg text-[14px] font-semibold transition-opacity hover:opacity-90 ${
                    "highlighted" in tier && tier.highlighted
                      ? "bg-[var(--m-text)] text-[var(--m-bg)]"
                      : "border border-[var(--m-border)] text-[var(--m-text)]"
                  }`}
                >
                  {tier.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Included in every plan */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[900px] mx-auto px-6 py-20 text-center">
          <SectionHeading eyebrow="Standard, not an upsell" title="What's included in every plan" align="center" />
          <div className="mt-10 grid sm:grid-cols-2 gap-4" data-reveal>
            {PRICING_INCLUDED.map((item) => (
              <div key={item} className="flex items-center gap-2.5 text-[14.5px] text-[var(--m-text-secondary)] justify-center sm:justify-start px-4">
                <Check className="w-4 h-4 text-[var(--m-text)] shrink-0" aria-hidden />
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison table */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="How we compare" title="Everyone else sells you a tool. We do the job." align="center" />
          <div className="mt-12 overflow-x-auto" data-reveal>
            <table className="w-full border-collapse min-w-[640px]">
              <thead>
                <tr>
                  <th className="text-left text-[12px] font-medium uppercase tracking-wide text-[var(--m-text-muted)] pb-4 pr-4"> </th>
                  {COMPARISON_TABLE.columns.map((col) => (
                    <th key={col} className="text-left text-[13px] font-bold text-[var(--m-text)] pb-4 px-4">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_TABLE.rows.map((row) => (
                  <tr key={row.label} className="border-t border-[var(--m-border)]">
                    <td className="py-4 pr-4 text-[13.5px] font-medium text-[var(--m-text)] whitespace-nowrap">{row.label}</td>
                    {row.values.map((v, i) => (
                      <td key={i} className={`py-4 px-4 text-[13.5px] leading-snug ${i === 0 ? "font-semibold text-[var(--m-text)]" : "text-[var(--m-text-secondary)]"}`}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[760px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Pricing questions" title="Common questions about founder pricing" align="center" />
          <div className="mt-10 space-y-6" data-reveal>
            {PRICING_FAQ.map((f) => (
              <div key={f.q}>
                <h3 className="font-display font-bold text-[15.5px] text-[var(--m-text)]">{f.q}</h3>
                <p className="mt-1.5 text-[14.5px] text-[var(--m-text-secondary)] leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Lock in founder pricing before it's gone.
          </h2>
          <div className="mt-8">
            <WaitlistForm source="pricing" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
