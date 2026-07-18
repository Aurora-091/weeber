import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { useJsonLd } from "../../lib/useJsonLd";

export interface Crumb {
  label: string;
  href: string;
}

/**
 * Visible breadcrumb trail + matching BreadcrumbList JSON-LD — used on nested marketing pages
 * (e.g. Compliance > India) so both users and search/answer engines can place the page in the
 * site hierarchy at a glance.
 */
export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  useJsonLd(
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: trail.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.label,
        item: `https://www.weeber.ai${c.href}`,
      })),
    },
    `breadcrumb-${trail.map((c) => c.href).join("-")}`,
  );

  return (
    <nav aria-label="Breadcrumb" data-reveal className="flex items-center flex-wrap gap-1.5 text-[13px] text-[var(--m-text-muted)]">
      {trail.map((c, i) => (
        <span key={c.href} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 opacity-60" aria-hidden />}
          {i === trail.length - 1 ? (
            <span className="text-[var(--m-text-secondary)] font-medium" aria-current="page">
              {c.label}
            </span>
          ) : (
            <Link href={c.href} className="hover:text-[var(--m-text)] transition-colors">
              {c.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
