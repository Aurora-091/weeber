/**
 * Single source of truth for admin/app route prefixes across the whole
 * frontend — every <Route>, every nav href, every navigate()/Redirect call
 * goes through adminPath()/appPath() instead of hardcoding "/dashboard" or
 * "/app" directly, so this is the only place that needs to change when the
 * subdomain split (admin.weeber.ai / app.weeber.ai) actually goes live.
 *
 * Today (VITE_APP_SURFACE=all, the only real deployment) admin and merchant
 * routes share one origin, so they need distinct prefixes to avoid
 * colliding (both would otherwise want e.g. "/agents"). Once a dedicated
 * per-surface build exists (VITE_APP_SURFACE=admin / =merchant, one Vercel
 * project each), that build only ever serves its own routes on its own
 * origin — no collision possible — so it gets bare paths, matching
 * Vocalist's actual shipped pattern (physically separate CustomerApp.tsx /
 * AdminApp.tsx route trees, not one tree with role-based hiding).
 */
const surface = (import.meta.env.VITE_APP_SURFACE || "all") as "public" | "admin" | "merchant" | "all";

/** Only the combined single-deploy mode needs prefixes at all. */
const isCombinedDeploy = surface === "all";

export const ADMIN_BASE = isCombinedDeploy ? "/dashboard" : "";
export const APP_BASE = isCombinedDeploy ? "/app" : "";

/** e.g. adminPath("/agents") -> "/dashboard/agents" (combined) or "/agents" (dedicated admin build). adminPath() with no arg -> the admin root. */
export function adminPath(subpath = ""): string {
  if (!subpath || subpath === "/") return ADMIN_BASE || "/";
  return `${ADMIN_BASE}${subpath}`;
}

/** Same as adminPath(), for the merchant/user app surface. */
export function appPath(subpath = ""): string {
  if (!subpath || subpath === "/") return APP_BASE || "/";
  return `${APP_BASE}${subpath}`;
}
