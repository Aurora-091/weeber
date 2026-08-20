import { SearchX } from "lucide-react";
import { Link } from "wouter";
import { EmptyState } from "./empty-state";
import { Button } from "../ui/button";

/**
 * In-shell 404 — the authenticated-surface counterpart to
 * pages/not-found.tsx (which renders full-page, outside any shell, for the
 * public marketing site). Used as the catch-all route inside AdminAppRoutes
 * and UserAppRoutes so an unmatched /dashboard or /app sub-path shows a real
 * not-found state with the nav still visible, instead of silently bouncing
 * back to the surface's home — a soft-404 that hides typo'd or stale links
 * (e.g. an old bookmark to a deleted call/workflow ID) rather than surfacing
 * them.
 */
export function NotFoundPanel({ homeHref, homeLabel }: { homeHref: string; homeLabel: string }) {
  return (
    <EmptyState
      icon={SearchX}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={
        <Button asChild>
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      }
    />
  );
}
