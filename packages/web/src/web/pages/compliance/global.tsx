import { usePageMeta } from "../../lib/usePageMeta";
import { MarketingPageShell } from "../../components/marketing/MarketingPageShell";
import { Breadcrumbs } from "../../components/marketing/Breadcrumbs";
import { WaitlistForm } from "../../components/marketing/WaitlistForm";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="max-w-[760px] mx-auto px-6 py-10 border-b border-[var(--m-border)]" data-reveal>
      <h2 className="font-display text-[22px] font-bold text-[var(--m-text)] mb-4">{title}</h2>
      <div className="space-y-4 text-[15px] text-[var(--m-text-secondary)] leading-relaxed">{children}</div>
    </section>
  );
}

/** Same "actually enforced, not aspirational" discipline as the India page and terms.tsx §tcpa. */
export function ComplianceGlobalPage() {
  usePageMeta({
    title: "US, EU & Global Compliance — TCPA & GDPR",
    description:
      "How Weeber handles compliance outside India: US federal TCPA calling-window and Do-Not-Call enforcement, state mini-TCPA rules, and GDPR data-subject rights for EU callers.",
    path: "/compliance/global",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-12 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <Breadcrumbs
            trail={[
              { label: "Home", href: "/" },
              { label: "Compliance", href: "/compliance" },
              { label: "US, EU & global", href: "/compliance/global" },
            ]}
          />
          <h1 data-reveal className="mt-6 font-display text-[clamp(2rem,4.5vw,3.2rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[var(--m-text)]">
            Compliance outside India
          </h1>
          <p data-reveal className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            US federal TCPA, state mini-TCPA rules, and GDPR — what applies, and what Weeber
            actually enforces for it today.
          </p>
        </div>
      </section>

      <Section title="US federal TCPA — calling windows & Do-Not-Call">
        <p>
          The Telephone Consumer Protection Act (TCPA) sets a federal baseline calling window of
          8am-9pm in the recipient's own local time, plus Do-Not-Call requirements. Weeber checks
          both automatically before every outbound call — the Do-Not-Call check has no exceptions
          or override, for any user or configuration.
        </p>
      </Section>

      <Section title="State mini-TCPA rules">
        <p>
          Several US states set narrower calling windows than the federal baseline — Florida,
          Oklahoma, and Washington currently cap outbound calling at 8pm rather than 9pm. Weeber
          applies the narrower of the federal or state-specific window automatically based on the
          recipient's number, rather than leaving it to you to track state-by-state.
        </p>
      </Section>

      <Section title="Consent, scoped to purpose">
        <p>
          For call types that legally require prior consent (marketing/promotional outreach), we
          maintain a consent record scoped to that specific purpose — consent for one purpose (like
          order-status updates) doesn't authorize a different purpose (like marketing). Withdrawing
          consent stops future calls of that purpose. This is real infrastructure, being rolled out
          purpose-by-purpose across workflows, not a claim that every call type is fully wired to it
          yet.
        </p>
      </Section>

      <Section title="GDPR — EU callers and data subjects">
        <p>
          For callers in the EU, GDPR governs the same underlying data (recordings, transcripts,
          captured facts) as a matter of data-subject rights: access, correction, deletion, and
          erasure requests are honored across every system that holds the data — not just the most
          visible one. Where your data physically resides depends on your organization's region;
          contact us directly if data residency is a hard requirement for your account.
        </p>
      </Section>

      <Section title="AI-call disclosure">
        <p>
          Every AI-driven call opens with a spoken disclosure that the call may be recorded and that
          the caller is speaking with an AI system, before any other conversation happens — the
          exact wording spoken, and its version, is recorded against the call for audit purposes.
        </p>
      </Section>

      <Section title="Not a substitute for legal review">
        <p>
          This page describes what the platform enforces today, grounded in the actual code path —
          it's a good-faith, accurate description, not a certified legal document. Telemarketing and
          data-protection law is actively evolving across jurisdictions; get your specific use case
          reviewed by counsel before relying on this page alone.
        </p>
      </Section>

      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(24px,3.2vw,32px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Expanding beyond India, compliance-first.
          </h2>
          <div className="mt-8">
            <WaitlistForm source="compliance-global" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
