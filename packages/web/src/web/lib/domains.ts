/**
 * Cross-subdomain URL helpers for the split deploy.
 *
 * In production each surface lives on its own subdomain:
 *   www.weeber.ai   — marketing/waitlist (VITE_APP_SURFACE=public)
 *   admin.weeber.ai — internal admin panel (VITE_APP_SURFACE=admin)
 *   app.weeber.ai   — merchant-facing product (VITE_APP_SURFACE=merchant)
 *
 * In local dev (VITE_APP_SURFACE=all or unset) all three are the same origin,
 * so these helpers return relative paths — no external navigation needed.
 */

const WWW_ORIGIN = import.meta.env.VITE_WWW_ORIGIN as string | undefined;
const ADMIN_ORIGIN = import.meta.env.VITE_ADMIN_ORIGIN as string | undefined;
const APP_ORIGIN = import.meta.env.VITE_APP_ORIGIN as string | undefined;

export function wwwUrl(path = "/"): string {
  return WWW_ORIGIN ? `${WWW_ORIGIN}${path}` : path;
}

export function adminUrl(path = "/dashboard"): string {
  return ADMIN_ORIGIN ? `${ADMIN_ORIGIN}${path}` : path;
}

export function appUrl(path = "/app"): string {
  return APP_ORIGIN ? `${APP_ORIGIN}${path}` : path;
}
