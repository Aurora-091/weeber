import { useEffect, useRef } from "react";

/**
 * Scroll-reveal hook — shared across every marketing page. Extracted from
 * landing.tsx's original inline `useReveal` (byte-identical behavior, only
 * the file moved) so /shopify, /pricing, /about, /faq, /contact all get the
 * same fade-in-on-scroll treatment via `data-reveal` attributes without
 * re-implementing the IntersectionObserver each time.
 */
export function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    const targets = el.querySelectorAll("[data-reveal]");
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, []);
  return ref;
}
