import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { SectionHeading } from "../components/marketing/SectionHeading";
import { BrandTile } from "../components/marketing/BrandLogos";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { UPCOMING_VERTICALS } from "../lib/marketing-config";

/** What's next — pulled off the landing page (it was repeating the vertical pitch a 3rd time
 * there) and given its own page instead, so the roadmap is genuinely explorable rather than a
 * cramped chip row competing with the actual product pitch. */
export function RoadmapPage() {
  usePageMeta({
    title: "Roadmap — What's Next for Weeber",
    description: "What Weeber is building next: WhatsApp, WordPress, Google Calendar, and Meta integrations, plus clinics, hotels, real estate, and logistics verticals.",
    path: "/roadmap",
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[700px] mx-auto">
          <h1 data-reveal className="font-display text-[clamp(2.2rem,5vw,3.6rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-[var(--m-text)]">
            What's next
          </h1>
          <p data-reveal className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            Shopify and Insurance are built and live today. Here's what we're building after that — sequenced by waitlist demand, not a fixed date.
          </p>
        </div>
      </section>

      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Integrations" title="More connectors, self-serve" align="center" />
          <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-[500px] mx-auto" data-reveal>
            <BrandTile brand="whatsapp" />
            <BrandTile brand="wordpress" />
            <BrandTile brand="googlecalendar" />
            <BrandTile brand="meta" />
          </div>
          <p className="mt-8 text-center text-[14px] text-[var(--m-text-secondary)]">
            Don't see the one you need?{" "}
            <a href="mailto:hello@weeber.ai" className="link-grow font-semibold text-[var(--m-text)]">
              Request a connector →
            </a>
          </p>
        </div>
      </section>

      <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
        <div className="max-w-[1000px] mx-auto px-6 py-20">
          <SectionHeading eyebrow="Verticals" title="Where Weeber goes after Shopify and Insurance" align="center" />
          <div className="mt-10 grid sm:grid-cols-2 gap-4" data-reveal>
            {UPCOMING_VERTICALS.map((v) => (
              <div key={v.title} className="bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-[15px] p-6 card-lift">
                <div className="font-mono text-[10px] tracking-[.14em] uppercase text-[var(--m-text-muted)] mb-2">Coming soon</div>
                <h3 className="font-display text-[17px] font-bold tracking-[-0.02em] text-[var(--m-text)] mb-2">{v.title}</h3>
                <p className="text-[13.5px] text-[var(--m-text-secondary)] leading-relaxed">{v.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="waitlist" className="px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Want Weeber for your industry?
          </h2>
          <p className="mt-3 text-[15px] text-[var(--m-text-secondary)]">Tell us when you join — sequencing is based on waitlist demand.</p>
          <div className="mt-8">
            <WaitlistForm source="roadmap" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
