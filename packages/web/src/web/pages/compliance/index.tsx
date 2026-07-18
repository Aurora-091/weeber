import { ArrowRight, ShieldCheck, PhoneOff, Clock, FileCheck } from "lucide-react";
import { usePageMeta } from "../../lib/usePageMeta";
import { MarketingPageShell } from "../../components/marketing/MarketingPageShell";
import { SectionHeading } from "../../components/marketing/SectionHeading";
import { Breadcrumbs } from "../../components/marketing/Breadcrumbs";
import { WaitlistForm } from "../../components/marketing/WaitlistForm";

/**
 * Compliance hub — one real mechanism explained (not a marketing wall), then routes to the two
 * jurisdiction-specific pages. Same "describe what's actually true today" discipline as
 * privacy.tsx/terms.tsx: no claim here that isn't backed by the actual enforcement code path.
 */
const MECHANISMS = [
  {
    icon: PhoneOff,
    title: "Do-Not-Call, enforced with no exceptions",
    body: "Every outbound number is checked against the Do-Not-Call list before a call is placed — this cannot be bypassed by any user, workflow, or configuration.",
  },
  {
    icon: Clock,
    title: "Calling-window enforcement, by jurisdiction",
    body: "Calls only go out inside the hours permitted where the recipient actually is — checked automatically per call, not left for you to configure correctly.",
  },
  {
    icon: ShieldCheck,
    title: "Purpose-scoped consent",
    body: "Consent is tied to a specific purpose — agreeing to an order-status call doesn't authorize a marketing call. Withdrawing consent for a purpose stops future calls for that purpose.",
  },
  {
    icon: FileCheck,
    title: "Every decision is logged",
    body: "Full transcripts, recordings, and the exact disclosure version spoken are recorded against every call for audit purposes.",
  },
] as const;

export function ComplianceHubPage() {
  usePageMeta({
    title: "Compliance — How Weeber Enforces Consent & Calling Rules",
    description:
      "How Weeber's compliance engine actually works: Do-Not-Call enforcement, calling-window checks, and purpose-scoped consent — with jurisdiction-specific detail for India (DPDP/TRAI) and the US/EU (TCPA/GDPR).",
    path: "/compliance",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[760px] mx-auto">
          <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Compliance", href: "/compliance" }]} />
          <span data-reveal className="mt-6 inline-flex items-center gap-2 border border-[var(--m-text)] rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
            Compliance is a feature, not a disclaimer
          </span>
          <h1 data-reveal className="mt-6 font-display text-[clamp(2.2rem,5vw,3.6rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-[var(--m-text)]">
            Consent and calling rules, enforced in the infrastructure.
          </h1>
          <p data-reveal className="mt-5 text-[1.05rem] text-[var(--m-text-secondary)] leading-[1.6]">
            Every voice AI vendor says "compliant." Here's exactly what Weeber's compliance engine
            checks, on every single call, before it's allowed to dial — plain language, no legalese.
          </p>
        </div>
      </section>

      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="How it works" title="Four checks, on every call" align="center" />
          <div className="mt-12 grid sm:grid-cols-2 gap-4" data-reveal>
            {MECHANISMS.map((m) => (
              <div key={m.title} className="p-6 bg-[var(--m-bg)] border border-[var(--m-border)] rounded-[15px] card-lift">
                <m.icon className="w-5 h-5 text-[var(--m-text)]" strokeWidth={1.7} aria-hidden />
                <h3 className="mt-3 mb-2 font-display text-[16.5px] font-bold text-[var(--m-text)]">{m.title}</h3>
                <p className="text-[14px] text-[var(--m-text-secondary)] leading-relaxed">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Jurisdiction detail" title="The rules differ by country — the enforcement doesn't." align="center" />
          <div className="mt-12 grid md:grid-cols-2 gap-6" data-reveal>
            <a
              href="/compliance/india"
              className="group p-8 bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-2xl card-lift flex flex-col"
            >
              <span className="font-mono text-[11px] tracking-[.14em] uppercase text-[var(--m-text-muted)] mb-3">India</span>
              <h3 className="font-display text-[22px] font-extrabold tracking-[-0.02em] text-[var(--m-text)] mb-3">DPDP Act, TRAI & DLT</h3>
              <p className="text-[14.5px] text-[var(--m-text-secondary)] leading-relaxed mb-6 flex-1">
                Data protection under the DPDP Act, TRAI's calling-window and DND rules, and DLT
                registration for commercial calling in India.
              </p>
              <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[var(--m-text)] group-hover:gap-2.5 transition-all">
                Read India compliance <ArrowRight className="w-4 h-4" aria-hidden />
              </span>
            </a>
            <a
              href="/compliance/global"
              className="group p-8 bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-2xl card-lift flex flex-col"
            >
              <span className="font-mono text-[11px] tracking-[.14em] uppercase text-[var(--m-text-muted)] mb-3">US, EU & rest of world</span>
              <h3 className="font-display text-[22px] font-extrabold tracking-[-0.02em] text-[var(--m-text)] mb-3">TCPA, mini-TCPA & GDPR</h3>
              <p className="text-[14.5px] text-[var(--m-text-secondary)] leading-relaxed mb-6 flex-1">
                US federal TCPA calling-hour rules (narrower in Florida, Oklahoma, and Washington),
                and GDPR data-subject rights for EU callers.
              </p>
              <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[var(--m-text)] group-hover:gap-2.5 transition-all">
                Read US/EU compliance <ArrowRight className="w-4 h-4" aria-hidden />
              </span>
            </a>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[760px] mx-auto px-6 py-16 text-center" data-reveal>
          <p className="text-[14.5px] text-[var(--m-text-secondary)] leading-relaxed">
            This page describes what the platform enforces today, in good faith and grounded in the
            actual code path — it isn't a substitute for your own legal review. See our{" "}
            <a href="/privacy" className="underline">Privacy Policy</a> and{" "}
            <a href="/terms#tcpa" className="underline">Terms of Service</a> for the full legal
            language.
          </p>
        </div>
      </section>

      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Want compliance handled for you, not just documented?
          </h2>
          <div className="mt-8">
            <WaitlistForm source="compliance" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
