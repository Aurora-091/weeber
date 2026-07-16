import { usePageTitle } from "../lib/usePageTitle";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SectionHeading } from "../components/marketing/SectionHeading";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { THESIS_PRINCIPLES, TEAM, UPCOMING_VERTICALS } from "../lib/marketing-config";

export function AboutPage() {
  usePageTitle("About Weeber — Compliance-First Voice AI for Small Businesses");

  return (
    <MarketingPageShell>
      {/* Mission */}
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[760px] mx-auto">
          <h1 data-reveal className="font-display text-[clamp(2.2rem,5vw,3.8rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-[var(--m-text)]">
            Enterprise AI was built for enterprises.
            <br /> We built ours for everyone else.
          </h1>
        </div>
      </section>

      {/* Origin story */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[760px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Why we exist" title="A $12,000 phone call." />
          <div className="mt-8 space-y-5" data-reveal>
            <p className="text-[16px] text-[var(--m-text-secondary)] leading-relaxed">
              We watched a Shopify cart-recovery campaign — the kind every store runs — turn into a TCPA lawsuit
              because nobody checked consent before dialing. The tooling that made the calls easy to send made
              it just as easy to send them wrong.
            </p>
            <p className="text-[16px] text-[var(--m-text-secondary)] leading-relaxed">
              Every voice AI platform we looked at was built the same way: robotic voices, enterprise pricing,
              compliance bolted on as an afterthought (or not at all). None of them were built for a small
              business owner who just wants their phone answered and their carts recovered — without needing a
              legal team to keep them out of trouble.
            </p>
            <p className="text-[16px] text-[var(--m-text-secondary)] leading-relaxed">
              So we built the thing we wished existed: the Do-Not-Call check and calling-window rules enforced
              at the infrastructure level, not a disclaimer in the terms of service. You cannot dial a number
              on the Do-Not-Call list, or outside the hours its jurisdiction allows. That's not a feature you
              toggle on — it's how the system works.
            </p>
          </div>
        </div>
      </section>

      {/* Thesis */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="What we believe" title="Four principles behind every decision we make." />
          <div className="mt-12 grid md:grid-cols-2 gap-px bg-[var(--m-border)] border border-[var(--m-border)] overflow-hidden" data-reveal>
            {THESIS_PRINCIPLES.map((p) => (
              <div key={p.title} className="p-8 bg-[var(--m-bg)]">
                <h3 className="font-display font-bold text-[var(--m-text)] mb-2 text-[17px]">{p.title}</h3>
                <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Market / vision */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1100px] mx-auto px-6 py-20">
          <SectionHeading
            eyebrow="The market we're going after"
            title="Shopify first. Then every business that answers a phone."
            body="We're launching with e-commerce because the wedge is sharpest there — but the same voice workforce applies anywhere a missed call costs real money."
          />
          <div className="mt-12 grid sm:grid-cols-2 md:grid-cols-4 gap-6" data-reveal>
            {UPCOMING_VERTICALS.map((v) => (
              <div key={v.title} className="p-5 rounded-xl border border-[var(--m-border)] bg-[var(--m-bg)]">
                <h3 className="font-display font-bold text-[15px] text-[var(--m-text)] mb-1.5">{v.title}</h3>
                <p className="text-[13px] text-[var(--m-text-secondary)] leading-relaxed">{v.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Team */}
      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[760px] mx-auto px-6 py-20 text-center">
          <SectionHeading eyebrow="Team" title="A small, technical team building close to the problem." align="center" />
          <p data-reveal className="mt-5 text-[15px] text-[var(--m-text-secondary)] max-w-xl mx-auto leading-relaxed">
            We're a lean, India-based team — that's an advantage, not a caveat. It means we ship fast and we're
            close to one of the largest cost-sensitive SMB markets in the world.
          </p>
          <div className="mt-12 grid sm:grid-cols-2 gap-8 max-w-md mx-auto" data-reveal>
            {TEAM.map((member) => (
              <div key={member.name} className="text-center">
                <div className="mx-auto w-20 h-20 rounded-full bg-[var(--m-bg-alt)] border border-[var(--m-border)] flex items-center justify-center font-display text-xl font-bold text-[var(--m-text)]">
                  {member.name.split(" ").map((n) => n[0]).join("")}
                </div>
                <h3 className="mt-3 font-display font-bold text-[15px] text-[var(--m-text)]">{member.name}</h3>
                <p className="text-[13px] text-[var(--m-text-muted)]">{member.role}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Join the businesses building this with us.
          </h2>
          <div className="mt-8">
            <WaitlistForm source="about" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
