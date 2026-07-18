/**
 * Real brand logos/wordmarks, rendered monochrome — sourced from Wikimedia Commons (Shopify,
 * Salesforce, HubSpot, WordPress, Meta official logo SVGs; WhatsApp's icon mark, no separate
 * wordmark exists for it). Files live in /public/logos/*.svg, referenced here as CSS mask-images
 * so the ORIGINAL logo shape/lettering (each brand's real wordmark typography, not a font we
 * picked) renders as a flat silhouette tinted to the site's ink color (--m-text) — monochrome,
 * matching the theme, in light or dark mode automatically.
 *
 * Google Calendar (no distinct wordmark, only an icon) and GoHighLevel (no freely available
 * brand SVG) don't have a logo asset here — shown as a plain text label in the site's own type
 * instead of faking a logo we don't have.
 */

export type BrandKey = "shopify" | "hubspot" | "salesforce" | "gohighlevel" | "whatsapp" | "wordpress" | "googlecalendar" | "meta";

/** width:height aspect ratio of each source SVG, so the mask box doesn't distort the mark.
 * `hasWordmark` = the SVG itself already spells out the brand name (so we don't add a redundant
 * text caption underneath) — false for WhatsApp and Salesforce, whose available marks are
 * icon-only (no freely available Salesforce wordmark SVG exists; they're notably protective of
 * their logo). Those two get a small text caption below the icon instead. */
const BRAND_LOGO: Partial<Record<BrandKey, { file: string; ratio: number; hasWordmark: boolean }>> = {
  shopify: { file: "shopify.svg", ratio: 612 / 192, hasWordmark: true },
  salesforce: { file: "salesforce.svg", ratio: 273 / 191, hasWordmark: false },
  hubspot: { file: "hubspot.svg", ratio: 106 / 31, hasWordmark: true },
  wordpress: { file: "wordpress.svg", ratio: 1800 / 250, hasWordmark: true },
  meta: { file: "meta.svg", ratio: 948 / 191, hasWordmark: true },
  whatsapp: { file: "whatsapp.svg", ratio: 1, hasWordmark: false },
};

const BRAND_LABEL: Record<BrandKey, string> = {
  shopify: "Shopify",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  gohighlevel: "GoHighLevel",
  whatsapp: "WhatsApp",
  wordpress: "WordPress",
  googlecalendar: "Google Calendar",
  meta: "Meta",
};

export function BrandTile({ brand, size = "md" }: { brand: BrandKey; size?: "sm" | "md" }) {
  const logo = BRAND_LOGO[brand];
  const height = size === "sm" ? 20 : 24;

  return (
    <div className="flex flex-col items-center gap-2.5 text-center">
      <div className="flex items-center justify-center h-8">
        {logo ? (
          <span
            role="img"
            aria-label={BRAND_LABEL[brand]}
            className="brand-mono"
            style={{
              height,
              width: height * logo.ratio,
              maskImage: `url(/logos/${logo.file})`,
              WebkitMaskImage: `url(/logos/${logo.file})`,
            }}
          />
        ) : (
          <span className="font-display font-extrabold text-[13px] tracking-tight text-[var(--m-text)]">{BRAND_LABEL[brand]}</span>
        )}
      </div>
      {logo && !logo.hasWordmark && <span className="text-[10.5px] text-[var(--m-text-muted)] leading-tight">{BRAND_LABEL[brand]}</span>}
    </div>
  );
}
