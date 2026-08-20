import type { Page } from "@playwright/test";
import { settle } from "./_settle";

/**
 * The public-surface route list, shared by visual.spec.ts, a11y.spec.ts and
 * font-provenance.spec.ts.
 *
 * It lives here rather than being restated three times because of `redirectsTo`.
 * /app/login is not a page: it is an unauthenticated hit on the app surface, and
 * UserShell bounces it to the public sign-in form. All three suites therefore
 * measure /login, not /app/login — and all three have to wait for that bounce
 * before they read the DOM. A spec that knew about the redirect while its two
 * neighbours did not would go green while they stayed flaky, which is exactly
 * what happened before this file existed.
 *
 * WHY THE WAIT IS NEEDED
 * The bounce is client-side and fires once the Supabase session lookup resolves
 * (~400ms locally), i.e. AFTER page.goto() has returned and while settle() is
 * already reading the old document — which dies with "Execution context was
 * destroyed, most likely because of a navigation". Nothing about that is new:
 * the committed baseline has always been the sign-in form, reached through this
 * redirect. The race was just being won by luck, until the signed-out path
 * started awaiting a remote signOut() first and started losing it.
 *
 * The wait is also an assertion, not just a delay: if /app/login ever stops
 * landing on /login, these suites fail with an explicit URL timeout instead of
 * a pixel diff or a mystery blank-page report.
 */
export type PublicRoute = { name: string; path: string; redirectsTo?: string };

export const PUBLIC_ROUTES: PublicRoute[] = [
  { name: "landing", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "app-login", path: "/app/login", redirectsTo: "/login" },
];

/** goto + follow any declared client-side redirect + settle. */
export async function gotoPublic(page: Page, route: PublicRoute): Promise<void> {
  await page.goto(route.path);
  const target = route.redirectsTo;
  if (target) {
    await page.waitForURL((url) => url.pathname === target, { timeout: 20_000 });
  }
  await settle(page);
}
