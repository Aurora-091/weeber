/**
 * Nav-intent chunk prefetching.
 *
 * All in-shell pages are `lazy()`-loaded (see app.tsx). Clicking a sidebar
 * link to a page you haven't opened yet downloads its chunk on the spot, and
 * while that download is in flight the inner <Suspense fallback> paints
 * PageFallback over the whole content area — which reads as a "full page
 * reload" even though the shell never remounts.
 *
 * Fix: warm the target chunk the moment the user *intends* to navigate
 * (pointer hover / keyboard focus), so by click time the module is already in
 * the browser cache and React.lazy resolves without ever showing the
 * fallback. Purely additive and best-effort — a missing/misspelled entry just
 * means no prefetch (no correctness impact), and a second import() of an
 * already-loaded module is a cheap cache hit.
 *
 * This module deliberately imports nothing from app.tsx / app-shell.tsx to
 * keep the dependency graph acyclic: app.tsx (which owns the lazy imports)
 * registers loaders here, and app-shell's NavLink reads them.
 */

type Loader = () => Promise<unknown>;

const registry = new Map<string, Loader>();
const warmed = new Set<string>();

/** Register `href -> chunk loader` pairs. Called once at module load from app.tsx. */
export function registerPrefetch(entries: Record<string, Loader>): void {
  for (const [href, loader] of Object.entries(entries)) {
    registry.set(href, loader);
  }
}

/** Warm the chunk for `href` on nav intent. No-op if unknown or already warmed. */
export function prefetchRoute(href: string): void {
  if (warmed.has(href)) return;
  const loader = registry.get(href);
  if (!loader) return;
  warmed.add(href);
  // Swallow errors: a failed prefetch must never surface — the real
  // navigation will retry the import and let the error boundary handle it.
  loader().catch(() => warmed.delete(href));
}
