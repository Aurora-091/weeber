import { useEffect } from "react";

interface PageMetaOptions {
  /** Page title, without the " · Weeber" suffix — added automatically. */
  title: string;
  /** 1-2 sentence real description — used for meta description + OG/Twitter cards. */
  description: string;
  /** Path for the canonical URL, e.g. "/compliance/india". Defaults to the current pathname. */
  path?: string;
}

function upsertMeta(attr: "name" | "property", key: string, content: string): { el: Element; prev: string | null } {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  const prev = el?.getAttribute("content") ?? null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
  return { el, prev };
}

function upsertLink(rel: string, href: string): { el: Element; prev: string | null } {
  let el = document.querySelector(`link[rel="${rel}"]`);
  const prev = el?.getAttribute("href") ?? null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
  return { el, prev };
}

/**
 * Per-page SEO/AEO: title, meta description, canonical URL, and OG/Twitter title+description.
 * Restores the previous values on unmount so route changes don't leak stale tags into whatever
 * page loads next (this is a client-rendered SPA — index.html's static tags are the fallback for
 * the very first paint before hydration/route resolution, this hook keeps them accurate per-route
 * after that).
 */
export function usePageMeta({ title, description, path }: PageMetaOptions) {
  useEffect(() => {
    const prevTitle = document.title;
    const fullTitle = `${title} \u00b7 Weeber`;
    document.title = fullTitle;

    const desc = upsertMeta("name", "description", description);
    const ogTitle = upsertMeta("property", "og:title", fullTitle);
    const ogDesc = upsertMeta("property", "og:description", description);
    const twTitle = upsertMeta("name", "twitter:title", fullTitle);
    const twDesc = upsertMeta("name", "twitter:description", description);

    const url = `https://www.weeber.ai${path ?? window.location.pathname}`;
    const canonical = upsertLink("canonical", url);
    const ogUrl = upsertMeta("property", "og:url", url);

    return () => {
      document.title = prevTitle;
      if (desc.prev) desc.el.setAttribute("content", desc.prev);
      if (ogTitle.prev) ogTitle.el.setAttribute("content", ogTitle.prev);
      if (ogDesc.prev) ogDesc.el.setAttribute("content", ogDesc.prev);
      if (twTitle.prev) twTitle.el.setAttribute("content", twTitle.prev);
      if (twDesc.prev) twDesc.el.setAttribute("content", twDesc.prev);
      if (canonical.prev) canonical.el.setAttribute("href", canonical.prev);
      if (ogUrl.prev) ogUrl.el.setAttribute("content", ogUrl.prev);
    };
  }, [title, description, path]);
}
