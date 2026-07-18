import { Phone, UserCheck, CalendarClock, MessageSquareHeart, ShieldCheck, Repeat, Lock } from "lucide-react";
import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SectionHeading } from "../components/marketing/SectionHeading";
import { WaitlistForm } from "../components/marketing/WaitlistForm";

/**
 * Insurance vertical page — grounded in the 5 real agent prompts (docs/agent-prompts/04-08) and
 * the regulatory reference doc (00-insurance-regulatory-reference.md), not aspirational copy.
 * Same "never quoting, advising, or underwriting" hard line as the agent scripts themselves —
 * licensed-advisor routing is load-bearing regulatory language, not just marketing.
 */
const LEAK_STATS = [
  { value: "15 min", label: "the speed-to-lead window that decides whether a lead goes cold" },
  { value: "2\u20133", label: "missed renewal reminders before a policyholder just lapses" },
  { value: "1 human", label: "every quote, advice, and underwriting question always routes to" },
] as const;

const FLOWS = [
  {
    icon: MessageSquareHeart,
    title: "Lead follow-up",
    body: "Calls a new lead within minutes of capture — speed-to-lead matters far more here than in a renewal reminder.",
  },
  {
    icon: CalendarClock,
    title: "Policy renewal reminders",
    body: "Calls ahead of a renewal or premium due date, before it becomes a lapse. Escalates to a human on the second miss.",
  },
  {
    icon: UserCheck,
    title: "Appointment setting & warm transfer",
    body: "Confirms a qualified lead is still interested, then live-transfers to a licensed advisor — or books if no one's free.",
  },
  {
    icon: Phone,
    title: "Post-sale welcome",
    body: "Calls after a policy is issued to confirm the policyholder has their documents and welcome them properly.",
  },
  {
    icon: Repeat,
    title: "Feedback & NPS",
    body: "A short call after a servicing interaction or claim resolution — complaints route straight to a licensed human, not the agent.",
  },
] as const;

const SETUP_STEPS = [
  { step: "01", title: "Connect your systems", body: "Policy admin and lead/CRM sync — set up with our team, not a generic app-store install." },
  { step: "02", title: "Set licensed-advisor routing", body: "Tell us which advisors cover which states/lines of authority — the agent never skips this." },
  { step: "03", title: "Go live", body: "Renewal reminders, lead follow-up, and warm transfers start running." },
] as const;

export function InsuranceSolutionPage() {
  usePageMeta({
    title: "AI Voice Agent for Insurance — Lead Follow-Up, Renewals & Warm Transfer",
    description:
      "Weeber follows up insurance leads within minutes, reminds policyholders before renewal, and live-transfers to your licensed advisors — never quoting, advising, or underwriting.",
    path: "/insurance",
  });

  return (
    <MarketingPageShell>
      {/* Hero */}
      <section className="relative pt-32 pb-20 px-6 text-center overflow-hidden border-b border-[var(--m-border)]">
        <div className="relative z-10 max-w-[900px] mx-auto">
          <span data-reveal className="inline-flex items-center gap-2 border border-[var(--m-text)] rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold mb-6">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
            Built for agencies & brokers
          </span>
          <h1 data-reveal className="font-display text-[clamp(2.4rem,5.5vw,4.6rem)] font-extrabold leading-[0.98] tracking-[-0.03em] text-[var(--m-text)]">
            Every warm lead,
            <br /> followed up in minutes.
          </h1>
          <p data-reveal className="mt-6 text-[1.1rem] font-medium text-[var(--m-text-secondary)] max-w-[560px] mx-auto leading-[1.6]">
            Weeber qualifies leads, reminds policyholders before renewal, and live-transfers to your
            licensed advisors — it never quotes, advises, or underwrites. It knows exactly where its job ends.
          </p>
          <div data-reveal className="mt-10">
            <WaitlistForm source="insurance-solution" />
          </div>
        </div>
      </section>

      {/* Leak stats */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-16">
          <div className="grid sm:grid-cols-3 gap-4" data-reveal>
            {LEAK_STATS.map((s) => (
              <div key={s.label} className="text-center px-4">
                <div className="font-display font-extrabold text-[clamp(28px,3.5vw,40px)] text-[var(--m-text)]">{s.value}</div>
                <p className="mt-2 text-[13.5px] text-[var(--m-text-secondary)] leading-snug">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Flows */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
          <SectionHeading
            eyebrow="Real, built agent flows"
            title="Five flows, one hard line: never past the licensed human."
            body="Each of these is a real, guardrail-reviewed agent prompt today — not a roadmap slide."
          />
          <div className="mt-12 grid sm:grid-cols-2 md:grid-cols-3 gap-4" data-reveal>
            {FLOWS.map((f) => (
              <div key={f.title} className="p-6 bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-[15px] card-lift">
                <f.icon className="w-5 h-5 text-[var(--m-text)]" strokeWidth={1.7} aria-hidden />
                <h3 className="mt-3 mb-2 font-display text-[16px] font-bold text-[var(--m-text)]">{f.title}</h3>
                <p className="text-[13.5px] text-[var(--m-text-secondary)] leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The hard line */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[760px] mx-auto px-6 py-24 md:py-28 text-center">
          <SectionHeading eyebrow="The one rule that doesn't bend" title="Weeber never quotes, advises, or underwrites." align="center" />
          <p className="mt-6 text-[15px] text-[var(--m-text-secondary)] leading-relaxed" data-reveal>
            Every conversation that touches licensing-restricted territory — a quote, advice on
            coverage, anything underwriting-adjacent — routes to a licensed human advisor, live or
            by callback. The agent's job is speed and follow-through: reaching the lead fast,
            reminding the policyholder on time, and getting the right person on the line when it
            matters. Not replacing them.
          </p>
        </div>
      </section>

      {/* Data protection — DPDP-first, not a HIPAA-first pitch bolted on */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[760px] mx-auto px-6 py-24 md:py-28 text-center">
          <SectionHeading
            eyebrow="Data protection"
            title="Built to India's DPDP Act, not a US framework wearing local branding."
            align="center"
          />
          <p className="mt-6 text-[15px] text-[var(--m-text-secondary)] leading-relaxed" data-reveal>
            Policyholder data — a phone number, a call recording, anything captured during a
            renewal or claims call — is governed here by India's Digital Personal Data Protection
            Act, 2023, not HIPAA. We collect only what a specific workflow needs, disclose the AI
            and recording up front on every call, and honor deletion/access requests per the DPDP
            Act's actual mechanism. See the full{" "}
            <a href="/compliance/india" className="underline">India compliance page</a> for what's
            enforced today versus on the roadmap.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2 text-[13px] text-[var(--m-text-muted)]" data-reveal>
            <Lock className="w-4 h-4" aria-hidden />
            DPDP-first — HIPAA only applies if and when we serve a US health-adjacent workflow.
          </div>
        </div>
      </section>

      {/* Setup */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
          <SectionHeading eyebrow="Setup" title="Assisted setup, not a generic app install." body="Insurance workflows need licensed-advisor routing configured correctly before a single call goes out — so setup is done with our team, not a self-serve toggle." />
          <div className="mt-12 grid md:grid-cols-3 gap-px bg-[var(--m-border)] border border-[var(--m-border)] overflow-hidden" data-reveal>
            {SETUP_STEPS.map((s, i) => (
              <div key={s.step} className={`p-8 bg-[var(--m-bg)] ${i < SETUP_STEPS.length - 1 ? "border-b md:border-b-0 md:border-r border-[var(--m-border)]" : ""}`}>
                <div className="font-mono text-xs text-[var(--m-text-muted)] mb-5">{s.step}</div>
                <h3 className="font-display font-bold text-[var(--m-text)] mb-3 text-[17px]">{s.title}</h3>
                <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Building the insurance vertical alongside Shopify.
          </h2>
          <div className="mt-8">
            <WaitlistForm source="insurance" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
