import { Link } from "wouter";
import { ArrowLeft, Compass } from "lucide-react";
import { usePageMeta } from "../lib/usePageMeta";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { NAV_LINKS } from "../lib/marketing-config";

/**
 * Public 404 page. Replaces the old silent `<Redirect to="/" />` fallback, which
 * was a soft-404: any typo'd or dead URL returned the homepage, so search engines
 * treated broken links as duplicate-home content and visitors landed somewhere
 * they didn't ask for with no signal. This renders a real not-found state with
 * `noindex` (the correct client-side SPA equivalent of an HTTP 404) plus a few
 * escape hatches back into the site.
 */
export function NotFoundPage() {
  usePageMeta({
    title: "Page not found",
    description: "The page you're looking for doesn't exist or has moved.",
    noindex: true,
  });

  return (
    <MarketingPageShell>
      <section className="relative pt-40 pb-24 px-6 text-center">
        <div className="max-w-[620px] mx-auto">
          <p
            className="font-display font-extrabold text-[clamp(4rem,14vw,9rem)] leading-none tracking-[-0.04em] text-[var(--m-text)]/12 select-none"
            aria-hidden
          >
            404
          </p>
          <h1 className="-mt-4 font-display text-[clamp(1.6rem,4vw,2.4rem)] font-extrabold leading-[1.05] tracking-[-0.02em] text-[var(--m-text)]">
            This page doesn't exist.
          </h1>
          <p className="mt-4 text-[16px] text-[var(--m-text-secondary)] leading-relaxed">
            The link may be broken or the page may have moved. Let's get you back on track.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-full bg-[var(--m-text)] px-5 py-2.5 text-[14px] font-semibold text-[var(--m-bg)] transition-opacity hover:opacity-90"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden />
              Back to home
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-full border border-[var(--m-border)] px-5 py-2.5 text-[14px] font-semibold text-[var(--m-text)] transition-colors hover:bg-[var(--m-bg-alt)]"
            >
              <Compass className="w-4 h-4" aria-hidden />
              Contact us
            </Link>
          </div>

          <div className="mt-14 pt-8 border-t border-[var(--m-border)]">
            <p className="text-[13px] uppercase tracking-[0.12em] text-[var(--m-text-secondary)]">
              Or jump to
            </p>
            <nav className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-[14px] text-[var(--m-text-secondary)] transition-colors hover:text-[var(--m-text)]"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
