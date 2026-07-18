import { useEffect } from "react";

/**
 * Injects a JSON-LD `<script type="application/ld+json">` into `<head>` for the lifetime of the
 * mount, removed on unmount. index.html already ships the site-wide Organization/WebSite/
 * SoftwareApplication/FAQPage(home) schemas as static tags; this is for schema specific to a
 * single route (e.g. the full /faq page's FAQPage, or a compliance page's BreadcrumbList) that
 * shouldn't live in the static shell.
 */
export function useJsonLd(data: Record<string, unknown>, key: string) {
  useEffect(() => {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.dataset.jsonldKey = key;
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
