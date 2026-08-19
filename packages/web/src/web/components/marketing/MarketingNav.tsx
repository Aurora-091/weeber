import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import { NAV_LINKS } from "../../lib/marketing-config";
import { WeeberLogo } from "../WeeberLogo";
import { SkipToContent } from "./SkipToContent";

/** Marketing site nav — ported from Vocalist's MarketingNav.tsx, adapted
 * from react-router-dom (Link `to=`, object-returning useLocation) to
 * wouter (Link `href=`, tuple-returning useLocation). */
export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  // Login/signup is intentionally hidden from the marketing header for now — the CTA here is
  // conversion (join the waitlist), not account access. Add the login link back once there's a
  // reason for a visitor to want it from the public site.
  const waitlistHref = location === "/" ? "#waitlist" : "/#waitlist";

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 10);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
    <SkipToContent />
    <header
      
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-200 ${
        scrolled
          ? "bg-[var(--m-bg)]/86 backdrop-blur-[10px] border-b border-[var(--m-border)]"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-[1100px] mx-auto px-6 h-[66px] flex items-center justify-between">
        <Link href="/" className="flex items-center">
          <WeeberLogo size="md" />
        </Link>

        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[15px] text-[var(--m-text-secondary)] hover:text-[var(--m-text)] transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-2.5">
          <Link
            href="/faq"
            className="px-4 py-2 text-[14px] font-medium text-[var(--m-text-secondary)] border border-[var(--m-border)] rounded-full hover:text-[var(--m-text)] hover:border-[var(--m-text-muted)] transition-all"
          >
            Help
          </Link>
          <Link
            href="/login"
            className="px-4 py-2 text-sm font-medium text-[var(--m-text-secondary)] hover:text-[var(--m-text)] transition-colors"
          >
            Sign in
          </Link>
          <a
            href={waitlistHref}
            className="px-4 py-2 text-[14px] font-medium text-[var(--m-bg)] bg-[var(--m-text)] rounded-full hover:opacity-90 transition-opacity"
          >
            Join the waitlist
          </a>
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden p-2 text-[var(--m-text)]"
          aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div id="mobile-nav" className="md:hidden bg-[var(--m-bg)] border-b border-[var(--m-border)] px-6 pb-6">
          <nav aria-label="Mobile navigation" className="flex flex-col gap-4 mb-6">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="text-sm text-[var(--m-text-secondary)] hover:text-[var(--m-text)]">
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-2">
              <Link
                href="/faq"
                className="flex-1 text-center px-4 py-2.5 text-[14px] font-medium text-[var(--m-text-secondary)] border border-[var(--m-border)] rounded-full hover:text-[var(--m-text)] transition-colors"
              >
                Help
              </Link>
              <Link
                href="/login"
                className="flex-1 text-center px-4 py-2.5 text-sm font-medium text-[var(--m-text-secondary)] border border-[var(--m-border)] rounded-full hover:text-[var(--m-text)] transition-colors"
              >
                Sign in
              </Link>
            </div>
            <a
              href={waitlistHref}
              className="w-full text-center px-4 py-2.5 text-[14px] font-medium text-[var(--m-bg)] bg-[var(--m-text)] rounded-full hover:opacity-90 transition-opacity"
            >
              Join the waitlist
            </a>
          </div>
        </div>
      )}
    </header>
    </>
  );
}
