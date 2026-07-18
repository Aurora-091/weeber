import type { LucideIcon } from "lucide-react";
import { ShieldCheck, PhoneOff, FileCheck, UserCheck, Languages, AlertTriangle } from "lucide-react";
import { usePageMeta } from "../../lib/usePageMeta";
import { MarketingPageShell } from "../../components/marketing/MarketingPageShell";
import { Breadcrumbs } from "../../components/marketing/Breadcrumbs";
import { WaitlistForm } from "../../components/marketing/WaitlistForm";

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <section className="max-w-[760px] mx-auto px-6 py-10 border-b border-[var(--m-border)]" data-reveal>
      <div className="flex items-center gap-2.5 mb-4">
        <Icon className="w-5 h-5 text-[var(--m-text)] flex-none" strokeWidth={1.7} aria-hidden />
        <h2 className="font-display text-[22px] font-bold text-[var(--m-text)]">{title}</h2>
      </div>
      <div className="space-y-4 text-[15px] text-[var(--m-text-secondary)] leading-relaxed">{children}</div>
    </section>
  );
}

/**
 * Real content only, same discipline as privacy.tsx/terms.tsx — describes the actual enforced
 * mechanisms (DNC, calling-window, DLT) plus the DPDP Act as the governing law, without claiming
 * certifications or registrations Weeber doesn't hold. Not a substitute for legal review.
 */
export function ComplianceIndiaPage() {
  usePageMeta({
    title: "India Compliance — DPDP Act, TRAI & DLT",
    description:
      "How Weeber handles India-specific voice AI compliance: DPDP Act 2023 data protection, TRAI TCCCPR calling-window and DND enforcement, and DLT registration for commercial calling.",
    path: "/compliance/india",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-12 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <Breadcrumbs
            trail={[
              { label: "Home", href: "/" },
              { label: "Compliance", href: "/compliance" },
              { label: "India", href: "/compliance/india" },
            ]}
          />
          <h1 data-reveal className="mt-6 font-display text-[clamp(2rem,4.5vw,3.2rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[var(--m-text)]">
            Compliance for calling in India
          </h1>
          <p data-reveal className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            DPDP Act, TRAI's TCCCPR framework, and DLT — what applies, and what Weeber actually
            enforces for it today.
          </p>
        </div>
      </section>

      <Section title="Digital Personal Data Protection (DPDP) Act, 2023" icon={ShieldCheck}>
        <p>
          India's DPDP Act governs how personal data — including a phone number, a call recording,
          and anything captured during a call — is collected, used, and retained. We process only
          what a specific workflow needs (e.g. a delivery confirmation, an appointment time), and
          every AI-handled call opens with a spoken disclosure that it may be recorded and that the
          caller is speaking with an AI system, before anything else happens.
        </p>
        <p>
          You can request a copy of, or deletion of, the data held about a phone number at any time
          — see our <a href="/privacy" className="underline">Privacy Policy</a> for the full
          mechanism.
        </p>
      </Section>

      <Section title="TRAI TCCCPR — calling windows & Do-Not-Disturb" icon={PhoneOff}>
        <p>
          TRAI's Telecom Commercial Communications Customer Preference Regulations set calling
          windows and a Do-Not-Disturb (DND) registry for commercial calls in India. Weeber enforces
          the calling window automatically: calls are only placed between 9am and 9pm IST, with no
          exceptions or manual override available to any user.
        </p>
        <p>
          For opt-outs, Weeber maintains and checks its own do-not-call list before every dial —
          any number that asks to stop, or that a merchant marks opted-out, is blocked from future
          calls with no override. Real-time scrubbing against the carrier-operated NCPR/DND
          registry itself (not just our own opt-out list) is on our roadmap, not live today — we'd
          rather say that plainly than round up to a compliance claim we can't yet back with code.
        </p>
      </Section>

      <Section title="DLT registration for commercial calling" icon={FileCheck}>
        <p>
          Commercial voice calls and SMS in India require registration through the Distributed
          Ledger Technology (DLT) platform operated by telecom carriers — this identifies the
          calling entity and the template/purpose of the communication to the network before it's
          allowed through. Merchants calling Indian numbers through Weeber go through DLT/telephony
          onboarding as part of setup, not as an afterthought bolted on post-launch.
        </p>
      </Section>

      <Section title="Consent, scoped to purpose" icon={UserCheck}>
        <p>
          For call types that require it (marketing/promotional outreach in particular), consent is
          tracked per purpose — consent for order-status calls doesn't authorize a marketing call,
          and withdrawing consent for a purpose stops future calls of that type. This is real
          infrastructure, being rolled out purpose-by-purpose across workflows, not a blanket claim
          that every call type is fully wired to it yet.
        </p>
      </Section>

      <Section title="Hindi & Hinglish calling" icon={Languages}>
        <p>
          Indian merchants can run bilingual English/Hindi agents, including natural code-mixed
          conversation — this is a real, shipped capability, not a roadmap item, and the same
          consent and calling-window checks apply regardless of language.
        </p>
      </Section>

      <Section title="Not a substitute for legal review" icon={AlertTriangle}>
        <p>
          This page describes what the platform enforces today, grounded in the actual code path —
          it's a good-faith, accurate description, not a certified legal document. Indian
          telecom/data-protection rules are actively evolving; get your specific use case reviewed
          by counsel before relying on this page alone.
        </p>
      </Section>

      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(24px,3.2vw,32px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Building for Indian merchants first.
          </h2>
          <div className="mt-8">
            <WaitlistForm source="compliance-india" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
