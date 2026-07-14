import type { ReactNode } from "react";
import { Toaster } from "../ui/sonner";
import { GrainOverlay } from "./GrainOverlay";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import { useReveal } from "../../lib/useReveal";

/**
 * Shared page frame for every marketing page beyond Home (/shopify,
 * /pricing, /about, /faq, /contact) — same `.marketing` root, grain
 * texture, nav/footer, and scroll-reveal wiring Home's landing.tsx uses,
 * so a new page is just its own `<section>`s, not a re-derivation of the
 * shell each time.
 */
export function MarketingPageShell({ children }: { children: ReactNode }) {
  const revealRef = useReveal();
  return (
    <div className="marketing min-h-full" ref={revealRef}>
      <Toaster />
      <GrainOverlay />
      <MarketingNav />
      <main id="main-content" className="marketing-content">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
