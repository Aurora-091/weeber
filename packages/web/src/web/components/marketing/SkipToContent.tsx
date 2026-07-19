/**
 * Keyboard/screen-reader "skip to content" link. Visually hidden until it
 * receives focus (the first Tab press on a fresh page load), then it appears
 * top-left and lets AT/keyboard users jump past the nav straight to
 * `#main-content` — which both the landing page and MarketingPageShell already
 * mark. Pure a11y hygiene, and on-brand given the compliance-first positioning.
 */
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-[var(--m-text)] focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-[var(--m-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--m-text)] focus:ring-offset-2"
    >
      Skip to content
    </a>
  );
}
