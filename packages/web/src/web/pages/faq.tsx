import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { usePageTitle } from "../lib/usePageTitle";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { WaitlistForm } from "../components/marketing/WaitlistForm";
import { FAQ_GROUPS } from "../lib/marketing-config";

function FaqItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-[var(--m-border)] py-4">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-4 text-left"
        aria-expanded={open}
      >
        <span className="font-display font-bold text-[15.5px] text-[var(--m-text)]">{q}</span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-[var(--m-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && <p className="mt-3 text-[14.5px] text-[var(--m-text-secondary)] leading-relaxed">{a}</p>}
    </div>
  );
}

export function FaqPage() {
  usePageTitle("FAQ — Voice AI for SMBs, Answered");
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[640px] mx-auto">
          <h1 data-reveal className="font-display text-[clamp(2.2rem,5vw,3.6rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-[var(--m-text)]">
            Frequently asked questions
          </h1>
          <p data-reveal className="mt-4 text-[15px] text-[var(--m-text-secondary)]">
            Short, direct answers — no marketing fluff.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="max-w-[760px] mx-auto space-y-12">
          {FAQ_GROUPS.map((group) => (
            <div key={group.title} data-reveal>
              <span className="font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">{group.title}</span>
              <div className="mt-3">
                {group.items.map((item) => {
                  const key = `${group.title}-${item.q}`;
                  return (
                    <FaqItem
                      key={key}
                      q={item.q}
                      a={item.a}
                      open={openKey === key}
                      onToggle={() => setOpenKey(openKey === key ? null : key)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-[var(--m-border)] px-6 py-24 text-center">
        <div className="max-w-[600px] mx-auto" data-reveal>
          <h2 className="font-display text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em] leading-[1.05] text-[var(--m-text)]">
            Still have a question?
          </h2>
          <p className="mt-3 text-[15px] text-[var(--m-text-secondary)]">
            Email <a href="mailto:hello@weeber.ai" className="underline">hello@weeber.ai</a> or join the waitlist and we'll reach out.
          </p>
          <div className="mt-8">
            <WaitlistForm source="faq" />
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
