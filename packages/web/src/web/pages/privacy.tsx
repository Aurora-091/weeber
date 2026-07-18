import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SITE } from "../lib/marketing-config";

/**
 * Real content, not filler — the footer has linked here since before this page existed
 * (`/privacy` was a dead link, see docs/marketing-and-consent-ui-plan.md Part A #2). Written to
 * describe what the platform actually does today, not aspirationally: the consent ledger (purpose-
 * scoped, per docs/global-compliance-engine-plan.md) is real but not yet wired into every workflow,
 * so this deliberately says "we check consent by purpose before dialing for consent-gated
 * purposes" rather than a blanket "every call is consent-verified" claim.
 *
 * Not a substitute for legal review — flagged the same way the compliance code itself is
 * (consent.ts, hipaa.ts): this is a good-faith, accurate description of the system's actual
 * behavior, not a certified legal document. Get this reviewed by counsel before treating it as
 * final, same bar as anything else compliance-adjacent in this product.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="max-w-[760px] mx-auto px-6 py-10 border-b border-[var(--m-border)]">
      <h2 className="font-display text-[22px] font-bold text-[var(--m-text)] mb-4">{title}</h2>
      <div className="space-y-4 text-[15px] text-[var(--m-text-secondary)] leading-relaxed">{children}</div>
    </section>
  );
}

export function PrivacyPage() {
  usePageMeta({
    title: `Privacy Policy — ${SITE.name}`,
    description: `How ${SITE.name} collects, uses, and retains data — consent, calling-window enforcement, data residency, and your rights, described plainly and grounded in what the platform actually does.`,
    path: "/privacy",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-12 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <h1 className="font-display text-[clamp(2rem,4.5vw,3.2rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[var(--m-text)]">
            Privacy Policy
          </h1>
          <p className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            Last updated 2026-07-16. Plain language, not a legal wall of text — see "Questions" at the
            bottom for how to reach us about anything here.
          </p>
        </div>
      </section>

      <Section title="What we collect, and why">
        <p>
          When a {SITE.name} user calls one of their customers (or a customer calls in), we
          process: the phone number, the call recording and transcript, and any facts the agent
          captures during the call that are relevant to the reason for the call (e.g. a delivery
          confirmation, an appointment time, a satisfaction rating). We don't collect more than the
          specific workflow needs.
        </p>
        <p>
          Every AI-handled call opens with a spoken disclosure — that the call may be recorded and
          that the caller is speaking with an AI system — before anything else happens. The exact
          wording spoken, and which version of it, is recorded against the call for audit purposes.
        </p>
      </Section>

      <Section title="Consent">
        <p>
          Outbound calls are gated by two independent checks before they're placed: a Do-Not-Call
          check (no exceptions, ever — this cannot be bypassed by any user or configuration), and
          a calling-window check (calls are only placed within the hours permitted in the recipient's
          jurisdiction — e.g. 9am-9pm in India, 8am-9pm federally in the US, narrower in states with
          their own rules).
        </p>
        <p>
          For purposes that require explicit consent (for example, marketing outreach), we maintain a
          purpose-scoped consent record — consent given for one purpose (like order-status updates)
          never authorizes a different purpose (like marketing). Withdrawing consent for a purpose
          stops future calls for that purpose. This consent system is a real part of our
          infrastructure, not a policy we merely promise to follow — but as of this writing it's
          actively being rolled out purpose-by-purpose across our workflows, not yet covering every
          call type on the platform. We'll update this page as coverage expands rather than overstate
          it now.
        </p>
      </Section>

      <Section title="How long we keep data">
        <p>
          Call data (recordings, transcripts) is retained for a limited window and then deleted by
          default, unless a longer window is required for a specific regulatory reason (for example,
          HIPAA-covered health data, where a business associate agreement governs retention
          separately). Consent records themselves are kept longer than the underlying call data — up
          to 7 years — because proving that consent existed (and when it was withdrawn, if it was) is
          itself a compliance requirement, independent of how long the call recording is kept.
        </p>
      </Section>

      <Section title="Data residency">
        <p>
          Where your data physically lives depends on which region your organization is set up in.
          We're direct about this rather than making a blanket claim — if data residency in a specific
          country or region is a requirement for your organization, contact us and we'll confirm the
          exact answer for your account before you rely on it.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can request a copy of the data we hold about a phone number, request its deletion, or
          withdraw consent for a specific purpose at any time. Deletion requests are honored across
          every system that holds the data (calls, transcripts, cross-call memory) — not just the most
          visible one.
        </p>
      </Section>

      <Section title="Questions">
        <p>
          Reach out any time — see the Contact page, or the address on your account's user
          agreement. This policy describes the system as it actually works; if anything here doesn't
          match what you're seeing in your account, tell us — that's a bug in this page or in the
          product, and we want to know either way.
        </p>
      </Section>
    </MarketingPageShell>
  );
}
