import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SITE } from "../lib/marketing-config";

/**
 * Real content, not filler — same context as privacy.tsx: `/terms` (and the footer's `/terms#tcpa`
 * anchor) were dead links before this page existed. Same "describe what's actually true today"
 * discipline as privacy.tsx — not a certified legal document, get it reviewed by counsel before
 * treating it as final.
 */
function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="max-w-[760px] mx-auto px-6 py-10 border-b border-[var(--m-border)] scroll-mt-24">
      <h2 className="font-display text-[22px] font-bold text-[var(--m-text)] mb-4">{title}</h2>
      <div className="space-y-4 text-[15px] text-[var(--m-text-secondary)] leading-relaxed">{children}</div>
    </section>
  );
}

export function TermsPage() {
  usePageMeta({
    title: `Terms of Service — ${SITE.name}`,
    description: `${SITE.name}'s Terms of Service — acceptable use, TCPA/telemarketing compliance enforcement, and liability, describing what the platform actually enforces at dial time.`,
    path: "/terms",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-12 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <h1 className="font-display text-[clamp(2rem,4.5vw,3.2rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[var(--m-text)]">
            Terms of Service
          </h1>
          <p className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            Last updated 2026-07-16. See "TCPA & telemarketing compliance" below for the section our
            footer links to directly.
          </p>
        </div>
      </section>

      <Section title="Using the service">
        <p>
          {SITE.name} lets you configure and run AI voice agents that call your own customers (or
          answer their calls) for a specific business purpose you define — order updates,
          appointment reminders, feedback collection, and similar workflows. You're responsible for
          having a legitimate business relationship with the numbers you dial and for the accuracy of
          any customer data you provide to the platform.
        </p>
      </Section>

      <Section title="What you may not do">
        <p>
          You may not use {SITE.name} to make calls to a number on a Do-Not-Call list, outside the
          permitted calling hours for that recipient's jurisdiction, without the consent required for
          the type of call you're making, or for a purpose other than what consent was actually given
          for. These aren't just terms — they're enforced by the platform itself at dial time, and
          cannot be disabled through configuration, a support request, or any other means.
        </p>
      </Section>

      <Section id="tcpa" title="TCPA & telemarketing compliance">
        <p>
          Every outbound call placed through {SITE.name} passes two automatic gates before it's
          dialed: a Do-Not-Call check (US federal, plus applicable state lists) and a calling-window
          check appropriate to the recipient's country — for example, 8am-9pm in the recipient's own
          local time under the US federal TCPA baseline, narrower in states with their own rules
          (Florida, Oklahoma, and Washington currently cap at 8pm rather than 9pm), and 9am-9pm IST
          under India's TRAI TCCCPR framework.
        </p>
        <p>
          For calls that legally require prior consent (marketing/promotional outreach), we maintain
          a consent record scoped to the specific purpose of the call — a customer's consent to
          receive order-status calls does not, by itself, authorize a marketing call. Consent can be
          withdrawn at any time, and withdrawal is honored for future calls of that purpose.
        </p>
        <p>
          Every AI-driven call opens with a spoken disclosure that the call may be recorded and that
          the caller is speaking with an AI system, before any other conversation happens.
        </p>
        <p>
          This section describes what the platform enforces today. It is not a substitute for your
          own legal review of your specific use case, especially given that telemarketing law
          (calling-hour rules, consent-standard requirements, and AI-specific disclosure rules) is
          actively evolving in multiple jurisdictions as of this writing.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          {SITE.name} provides the infrastructure and compliance gates described above in good faith
          and to the best of our ability, but using the platform does not, by itself, guarantee legal
          compliance with every law applicable to your specific business, industry, or jurisdiction —
          particularly regulated industries like insurance and healthcare, where licensed-human
          involvement is often legally required for parts of the conversation the platform will
          always route to you rather than attempt itself.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          We'll update this page as the platform's actual compliance capabilities expand, and we'd
          rather under-promise here than describe something as fully built before it is — see
          "TCPA & telemarketing compliance" above for the current, accurate state.
        </p>
      </Section>
    </MarketingPageShell>
  );
}
