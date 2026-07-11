import { Link } from "wouter";
import { FOOTER_COLUMNS, SITE } from "../../lib/marketing-config";
import { WeeberLogo } from "../WeeberLogo";

/** Ported from Vocalist's MarketingFooter.tsx, adapted to wouter's Link API. */
export function MarketingFooter() {
  return (
    <footer aria-label="Site footer" className="bg-[#000000] text-white">
      <div className="max-w-[1200px] mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10">
          <div className="col-span-2 md:col-span-2">
            <WeeberLogo size="md" inverted />
            <p className="mt-3 text-sm text-white leading-relaxed max-w-[240px]">{SITE.description}</p>
          </div>
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <div className="text-xs font-medium tracking-widest uppercase text-white mb-4">{col.title}</div>
              <ul className="space-y-3">
                {col.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith("http") ? (
                      <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-sm text-white hover:text-white/70 transition-colors">
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-sm text-white hover:text-white/70 transition-colors">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-16 pt-8 border-t border-white/20 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="text-xs text-white">
            {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs text-white">{SITE.tagline}</div>
          </div>
        </div>
      </div>
    </footer>
  );
}
