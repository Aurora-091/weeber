import { useEffect, useRef, useState } from "react";
import { Lock, Shield, SlidersHorizontal, ArrowRight, PhoneOff, ShieldCheck, FileCheck } from "lucide-react";
import { Toaster } from "../components/ui/sonner";
import { usePageMeta } from "../lib/usePageMeta";
import { useWaitlistCount } from "../lib/useWaitlistCount";
import { useReveal } from "../lib/useReveal";
import { MarketingNav } from "../components/marketing/MarketingNav";
import { MarketingFooter } from "../components/marketing/MarketingFooter";
import { AgentDemoWidget } from "../components/marketing/AgentDemoWidget";
import { BrandTile } from "../components/marketing/BrandLogos";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { GrainOverlay } from "../components/marketing/GrainOverlay";
import { STATS, HOW_IT_WORKS, PLATFORM_FEATURES, SECURITY_FEATURES, VERTICAL_TABS } from "../lib/marketing-config";

/**
 * Weeber public waitlist/marketing page — faithfully ported from Vocalist's
 * src/pages/Waitlist.tsx (github.com/Aurora-091/Vocalist), per explicit
 * direction to replicate the design, copy, and animations exactly rather
 * than reinterpret into openvent's dark-monochrome `.theme-weeber` product
 * theme. Uses its own `.marketing` token set (--m-*, styles.css) —
 * deliberately not `.theme-weeber`, same separation Vocalist itself has
 * between its marketing site and product dashboard.
 *
 * Adapted for openvent's own stack (not a byte-copy):
 * - react-router-dom -> wouter (MarketingNav/Footer/logo already adapted).
 * - Supabase edge functions (waitlist-join, waitlist-phone, enterprise-inquire)
 *   -> openvent's own backend (POST /api/public/waitlist + /waitlist/phone +
 *   /enterprise-inquiry), reusing the referral/position/count system already
 *   built (ADR-041) — the visual layer changed, the working backend didn't.
 * - Referral URL uses window.location.origin instead of a hardcoded domain.
 */

const BASE_COUNT = 43;

function AnimatedStat({ value, label, delay }: { value: string; label: string; delay: number }) {
  const [displayed, setDisplayed] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const animated = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const numeric = parseFloat(value.replace(/[^0-9.]/g, ""));
    if (isNaN(numeric)) return;
    const prefix = value.match(/^[^0-9]*/)?.[0] || "";
    const suffix = value.match(/[^0-9.]*$/)?.[0] || "";

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry!.isIntersecting && !animated.current) {
          animated.current = true;
          const start = performance.now();
          const duration = 900;
          const from = Math.max(0, numeric - 20);
          function tick(now: number) {
            const p = Math.min(1, (now - start - delay) / duration);
            if (p < 0) {
              requestAnimationFrame(tick);
              return;
            }
            const eased = 1 - Math.pow(1 - p, 3);
            const current = Math.round((from + (numeric - from) * eased) * 10) / 10;
            const display = Number.isInteger(numeric) ? Math.round(current) : current.toFixed(0);
            setDisplayed(`${prefix}${display}${suffix}`);
            if (p < 1) requestAnimationFrame(tick);
            else setDisplayed(value);
          }
          requestAnimationFrame(tick);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, delay]);

  return (
    <div ref={ref}>
      <span className="block font-display font-extrabold text-[clamp(36px,4.5vw,52px)] leading-none tracking-[-0.04em] text-[var(--m-text)]">{displayed}</span>
      <p className="mt-2 text-[13.5px] text-[var(--m-text-secondary)] leading-snug">{label}</p>
    </div>
  );
}

function HeroBgWaveform() {
  const barCount = 64;
  const bars = Array.from({ length: barCount }, (_, i) => {
    const normalized = i / (barCount - 1);
    return 15 + 85 * Math.sin(normalized * Math.PI);
  });

  return (
    <div className="hero-bg hero-bg--wave" aria-hidden="true">
      {bars.map((h, i) => (
        <span key={i} className="hero-wave-bar" style={{ height: `${h}%`, animationDelay: `${i * 0.1}s` }} />
      ))}
    </div>
  );
}

function HeroBadge() {
  const { count } = useWaitlistCount();
  const displayCount = Math.max(BASE_COUNT, count ?? BASE_COUNT);
  return (
    <div className="mb-6 inline-flex items-center gap-2 bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-full px-3.5 py-1.5 text-[13px] text-[var(--m-text-secondary)]" data-reveal>
      <span className="w-[7px] h-[7px] rounded-full bg-[#22c55e] inline-block hero-pulse-dot" />
      {displayCount} businesses already on the waitlist
    </div>
  );
}

/** Simple 1-row, 2-column vertical picker — Shopify and Insurance side by side, each with its
 * own Explore CTA. No tab-switching; both are visible and scannable at once. */
function VerticalExplorer() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {VERTICAL_TABS.map((tab) => (
        <div key={tab.key} className="p-6 md:p-8 bg-[var(--m-bg)] border border-[var(--m-border)] rounded-2xl vertical-panel-glow card-lift flex flex-col">
          <div className="font-mono text-[11px] tracking-[.12em] uppercase text-[var(--m-text-muted)] mb-3">{tab.label}</div>
          <h3 className="font-display font-bold text-[var(--m-text)] text-[20px] md:text-[22px] leading-snug mb-4">{tab.headline}</h3>
          <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed mb-3">{tab.problem}</p>
          <p className="text-sm text-[var(--m-text)] leading-relaxed mb-6 flex-1">{tab.solution}</p>
          <div className="flex items-center justify-between pt-4 border-t border-[var(--m-border)]">
            <div>
              <div className="text-xs font-medium text-[var(--m-text)]">{tab.demoLabel}</div>
              <div className="text-[11px] text-[var(--m-text-muted)]">
                {tab.demoAccent} &middot; {tab.demoDuration}
              </div>
            </div>
            <a
              href={tab.cta.href}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--m-text)] text-[var(--m-bg)] text-[13px] font-semibold hover:opacity-90 transition-opacity"
            >
              {tab.cta.label} <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}


function LandingContent() {
  usePageMeta({
    title: "AI Voice Agents for Missed Calls — Join the Waitlist",
    description:
      "Weeber answers inbound calls, recovers abandoned carts, books appointments, and routes to humans — without breaking consent regulations. Join the waitlist for founder pricing.",
    path: "/",
  });
  const revealRef = useReveal();

  return (
    <div className="marketing min-h-full" ref={revealRef}>
      <Toaster />
      <GrainOverlay />
      <MarketingNav />

      <main id="main-content" className="marketing-content">
        {/* Hero */}
        <section
          id="waitlist"
          className="relative pt-28 pb-20 md:pb-24 px-6 text-center overflow-hidden"
          style={{ minHeight: "100svh", display: "flex", flexDirection: "column", justifyContent: "center" }}
        >
          <HeroBgWaveform />
          <div className="hero-fade" aria-hidden="true" />
          <div className="relative z-10 max-w-[900px] mx-auto">
            <HeroBadge />
            <h1 className="font-display text-[clamp(2.8rem,6vw,5.5rem)] font-extrabold leading-[0.93] tracking-[-0.03em] text-[var(--m-text)]" data-reveal>
              Every call you miss
              <br /> is a sale you just lost.
            </h1>
            <p className="mt-6 text-[1.1rem] font-medium text-[var(--m-text-secondary)] max-w-[480px] mx-auto leading-[1.6]" data-reveal>
              Voice AI that books, recovers carts, and follows up. 24/7. No code.
            </p>
            <div className="mt-10" data-reveal>
              <WaitlistForm source="landing" />
            </div>
          </div>
        </section>

        {/* Agent Demo */}
        <section className="border-t border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div className="mb-14" data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Live demos
              </span>
              <h2 className="mt-4 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] max-w-xl">Hear your agents in action.</h2>
              <p className="mt-3 text-[17px] text-[var(--m-text-secondary)] max-w-lg">
                Real calls, real conversations. Navigate between demos to hear how Weeber handles COD confirmations, appointment booking, and cart recovery.
              </p>
            </div>
            <div data-reveal>
              <AgentDemoWidget />
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
          <div className="max-w-[1100px] mx-auto px-6 py-14 md:py-16" data-reveal>
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-y-8">
              {STATS.map((s, i) => (
                <div
                  key={s.value}
                  className={`px-3 sm:px-6 ${i > 0 ? "sm:border-l border-[var(--m-border)]" : ""} ${i === 2 ? "sm:border-l-0 md:border-l" : ""} ${i > 1 ? "hidden md:block" : ""}`}
                >
                  <AnimatedStat value={s.value} label={s.label} delay={i * 120} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Verticals */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div className="mb-14" data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Use cases
              </span>
              <h2 className="mt-4 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] max-w-xl">
                The AI voice agent built for your business.
              </h2>
              <p className="mt-3 text-[17px] text-[var(--m-text-secondary)] max-w-lg leading-relaxed">
                Two verticals, real built-out agent flows behind each. Pick one to see exactly what Weeber does for it.
              </p>
            </div>
            <div data-reveal>
              <VerticalExplorer />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                How it works
              </span>
              <h2 className="mt-4 mb-12 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] max-w-xl">
                Built compliance-first, not bolted on.
              </h2>
            </div>
            <div className="grid md:grid-cols-3 gap-px bg-[var(--m-border)] border border-[var(--m-border)] overflow-hidden" data-reveal>
              {HOW_IT_WORKS.map((step, i) => {
                const Icon = [PhoneOff, ShieldCheck, FileCheck][i]!;
                return (
                  <div key={step.step} className={`p-8 bg-[var(--m-bg)] ${i < HOW_IT_WORKS.length - 1 ? "border-b md:border-b-0 md:border-r border-[var(--m-border)]" : ""}`}>
                    <div className="flex items-center justify-between mb-5">
                      <Icon className="w-5 h-5 text-[var(--m-text)]" strokeWidth={1.7} aria-hidden />
                      <span className="font-mono text-xs text-[var(--m-text-muted)]">{step.step}</span>
                    </div>
                    <h3 className="font-display font-bold text-[var(--m-text)] mb-3 text-[17px]">{step.title}</h3>
                    <p className="text-sm text-[var(--m-text-secondary)] leading-relaxed">{step.body}</p>
                  </div>
                );
              })}
            </div>
            <p className="mt-6 text-[14px] text-[var(--m-text-secondary)]" data-reveal>
              <a href="/compliance" className="link-grow font-semibold text-[var(--m-text)]">
                See the full compliance breakdown (India + US/EU) →
              </a>
            </p>
          </div>
        </section>

        {/* Platform + integrations */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div data-reveal>
              <span className="font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">What we're shipping</span>
              <h2 className="mt-3 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] max-w-2xl">
                A no-code voice platform that fits the tools you already run.
              </h2>
              <p className="mt-4 text-[17.5px] text-[var(--m-text-secondary)] max-w-xl">No engineers, no scripts to record.</p>
            </div>

            <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-x-7 gap-y-5 mb-14" data-reveal>
              {PLATFORM_FEATURES.map((f) => (
                <div key={f.title} className="flex items-start gap-3">
                  <span className="flex-none mt-0.5 w-[18px] h-[18px] text-[var(--m-text)]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l4 4 10-10" />
                    </svg>
                  </span>
                  <div>
                    <strong className="text-[15.5px] font-semibold text-[var(--m-text)]">{f.title}</strong>
                    <span className="block text-[14px] text-[var(--m-text-secondary)] mt-0.5">{f.body}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="text-center mb-10" data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)] justify-center">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Integrations
              </span>
              <h2 className="mt-3 font-display text-[clamp(24px,3vw,38px)] font-extrabold tracking-[-0.03em] leading-[1.1] text-[var(--m-text)] max-w-xl mx-auto">
                Connect Weeber to the tools you already run.
              </h2>
              <p className="mt-3 text-[17px] text-[var(--m-text-secondary)] max-w-lg mx-auto">Self-serve on Shopify. CRM sync is built and running today too — set up with our team.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-4" data-reveal>
              <div className="border border-[var(--m-border)] rounded-[16px] p-6 bg-[var(--m-bg)] card-lift">
                <div className="flex items-center gap-2.5 font-semibold text-[14px] mb-5">
                  <span className="w-7 h-7 rounded-[8px] border border-[var(--m-border)] flex items-center justify-center text-[var(--m-text)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M4 8h16v11H4zM4 8l2-4h12l2 4" />
                    </svg>
                  </span>
                  Self-serve today
                </div>
                <div className="flex justify-center">
                  <BrandTile brand="shopify" />
                </div>
                <p className="mt-3 text-center text-[11px] text-[var(--m-text-muted)]">One-click OAuth</p>
              </div>

              <div className="border border-[var(--m-border)] rounded-[16px] p-6 bg-[var(--m-bg)] card-lift">
                <div className="flex items-center gap-2.5 font-semibold text-[14px] mb-5">
                  <span className="w-7 h-7 rounded-[8px] border border-[var(--m-border)] flex items-center justify-center text-[var(--m-text)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m5-4.13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6 0a4 4 0 1 0 0-8" />
                    </svg>
                  </span>
                  Built &amp; live, assisted setup
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <BrandTile brand="hubspot" size="sm" />
                  <BrandTile brand="salesforce" size="sm" />
                  <BrandTile brand="gohighlevel" size="sm" />
                </div>
              </div>

              <div className="border border-[var(--m-border)] rounded-[16px] p-6 bg-[var(--m-bg)] card-lift">
                <div className="flex items-center gap-2.5 font-semibold text-[14px] mb-5">
                  <span className="w-7 h-7 rounded-[8px] border border-[var(--m-border)] flex items-center justify-center text-[var(--m-text)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M4 19V11M10 19V5M16 19v-7M2 19h20" />
                    </svg>
                  </span>
                  On the roadmap
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <BrandTile brand="whatsapp" size="sm" />
                  <BrandTile brand="wordpress" size="sm" />
                  <BrandTile brand="googlecalendar" size="sm" />
                  <BrandTile brand="meta" size="sm" />
                </div>
              </div>
            </div>

            <p className="mt-5 text-[14.5px] text-[var(--m-text-secondary)]" data-reveal>
              <strong className="text-[var(--m-text)]">Shopify self-serve, CRM sync assisted, more connectors on the way.</strong> Don't see the one you need?{" "}
              <a href="mailto:hello@weeber.ai" className="link-grow font-semibold text-[var(--m-text)]">
                Request a connector →
              </a>{" "}
              <a href="/roadmap" className="link-grow font-semibold text-[var(--m-text)]">
                See the full roadmap →
              </a>
            </p>
          </div>
        </section>

        {/* Security */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Your data, yours alone
              </span>
              <h2 className="mt-4 mb-12 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] max-w-xl">
                Customer conversations are sensitive. We treat them that way.
              </h2>
            </div>
            <div className="grid md:grid-cols-3 gap-4" data-reveal>
              {SECURITY_FEATURES.map((f, i) => {
                const Icon = [Shield, Lock, SlidersHorizontal][i]!;
                return (
                  <div key={f.title} className="bg-[var(--m-bg)] border border-[var(--m-border)] rounded-[15px] p-6 card-lift">
                    <Icon className="w-5 h-5 text-[var(--m-text)]" strokeWidth={1.7} />
                    <h3 className="mt-3 mb-2 font-display text-[16.5px] font-bold text-[var(--m-text)]">{f.title}</h3>
                    <p className="text-[14px] text-[var(--m-text-secondary)] leading-relaxed">{f.body}</p>
                  </div>
                );
              })}
            </div>
            <p className="mt-7 text-[14.5px] text-[var(--m-text-secondary)]" data-reveal>
              <strong className="text-[var(--m-text)]">Compliant by design.</strong> Weeber meets the data-protection standards your industry requires, with controls built in from day one.
            </p>
          </div>
        </section>

        {/* Why we exist */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div className="grid md:grid-cols-2 gap-16 items-start" data-reveal>
              <div>
                <span className="font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">Why we exist</span>
                <h2 className="mt-3 font-display text-[clamp(28px,3.4vw,40px)] font-extrabold tracking-[-0.03em] leading-[1.08] text-[var(--m-text)]">
                  Enterprise AI was built for enterprises. <span className="text-[var(--m-text-secondary)]">We built ours for everyone else.</span>
                </h2>
              </div>
              <div className="space-y-4 text-[var(--m-text-secondary)] leading-relaxed">
                <p>The voice AI market was designed for companies with legal teams and six-figure budgets. Compliance was an afterthought — added after lawsuits, not designed in from day one.</p>
                <p>
                  We watched a Shopify merchant receive a $12,000 TCPA fine for a cart-recovery campaign their vendor told them was "compliant." The consent model was wrong. The opt-out mechanism was
                  broken. The audit trail didn't exist.
                </p>
                <p>Weeber enforces consent at the infrastructure level. You literally cannot dial a number that hasn't passed our consent gate. That's the product.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Founders */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg)]">
          <div className="max-w-[1100px] mx-auto px-6 py-24 md:py-28">
            <div className="max-w-[760px]" data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Why we built Weeber
              </span>
              <blockquote className="mt-5 font-display text-[clamp(20px,2.4vw,28px)] font-bold tracking-[-0.02em] leading-[1.4] text-[var(--m-text)]">
                "We kept watching good businesses lose customers to a phone nobody could answer — and watched 'AI calling' tools that sounded like robots. So we built one that sounds human, sets up
                in an afternoon, and works for the business you actually run."
              </blockquote>
              <div className="mt-6 flex items-center gap-4">
                <span className="w-11 h-11 rounded-full bg-[var(--m-accent-bg)] text-[var(--m-accent-fg)] flex items-center justify-center font-display font-bold text-sm flex-none">W</span>
                <div className="flex items-center gap-6">
                  <div>
                    <strong className="text-[15px] font-semibold text-[var(--m-text)]">Ashutosh Tiwari</strong>
                    <span className="block text-[13.5px] text-[var(--m-text-secondary)]">Founder, Weeber</span>
                  </div>
                  <span className="text-[var(--m-border)]">&</span>
                  <div>
                    <strong className="text-[15px] font-semibold text-[var(--m-text)]">Rushikesh Pawar</strong>
                    <span className="block text-[13.5px] text-[var(--m-text-secondary)]">Co-founder, Weeber</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ teaser — full FAQ lives at /faq only, so this doesn't duplicate it */}
        <section className="border-b border-[var(--m-border)] bg-[var(--m-bg-alt)]">
          <div className="max-w-[1100px] mx-auto px-6 py-20 md:py-24 text-center">
            <div data-reveal>
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)] justify-center">
                <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
                Questions
              </span>
              <h2 className="mt-4 font-display text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
                Good to know before you join.
              </h2>
              <p className="mt-3 text-[15.5px] text-[var(--m-text-secondary)] max-w-md mx-auto">
                Setup, pricing, compliance, languages — short direct answers, no marketing fluff.
              </p>
              <a
                href="/faq"
                className="mt-7 inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full border border-[var(--m-border)] text-[14px] font-semibold text-[var(--m-text)] hover:border-[var(--m-text-muted)] transition-colors"
              >
                Read the full FAQ <ArrowRight className="w-4 h-4" aria-hidden />
              </a>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}

export default function LandingPage() {
  return <LandingContent />;
}
