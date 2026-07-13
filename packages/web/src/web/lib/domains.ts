/**
 * Cross-subdomain URL helpers for the split deploy.
 *
 * In production each surface lives on its own subdomain:
 *   www.weeber.ai   — marketing/waitlist (VITE_APP_SURFACE=public)
 *   admin.weeber.ai — internal admin panel (VITE_APP_SURFACE=admin)
 *   app.weeber.ai   — user-facing product (VITE_APP_SURFACE=user)
 *
 * In local dev (VITE_APP_SURFACE=all or unset) all three are the same origin,
 * so these helpers return relative paths — no external navigation needed.
 *
 * Every subpath argument here is BARE (e.g. "/login", not "/app/login") —
 * adminPath()/appPath() (route-base.ts) add whatever prefix the current
 * build actually needs (none, once a dedicated per-surface build exists;
 * "/dashboard"/"/app" only in today's combined single deploy). Callers never
 * hardcode the prefix themselves.
 */
import { adminPath, appPath } from "./route-base";

const WWW_ORIGIN = import.meta.env.VITE_WWW_ORIGIN as string | undefined;
const ADMIN_ORIGIN = import.meta.env.VITE_ADMIN_ORIGIN as string | undefined;
const APP_ORIGIN = import.meta.env.VITE_APP_ORIGIN as string | undefined;

export function wwwUrl(path = "/"): string {
  return WWW_ORIGIN ? `${WWW_ORIGIN}${path}` : path;
}

export function adminUrl(subpath = ""): string {
  const path = adminPath(subpath);
  return ADMIN_ORIGIN ? `${ADMIN_ORIGIN}${path}` : path;
}

export function appUrl(subpath = ""): string {
  const path = appPath(subpath);
  return APP_ORIGIN ? `${APP_ORIGIN}${path}` : path;
}
