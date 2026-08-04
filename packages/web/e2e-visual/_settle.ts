import type { Page } from "@playwright/test";

/**
 * Everything a page must have finished doing before a screenshot is allowed to
 * be taken. Each step here exists because of a specific way a screenshot goes
 * non-deterministic — none of them are decoration.
 */

/**
 * Block the API before the first navigation.
 *
 * The harness seeds react-query with staleTime:Infinity, but unseeded queries
 * still fire. Against `vite preview` those requests hit a static file server
 * which answers the SPA index.html with a 200 — so a fetch that should fail
 * instead resolves with HTML, and the page renders whatever a JSON parse error
 * produces. Aborting makes the failure honest and identical every run.
 */
export async function blockApi(page: Page) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/*.{woff,woff2,ttf}", (route) => route.continue());
}

/**
 * Hosts a screenshot run is allowed to reach. Everything else off-origin is
 * aborted by `blockOffOrigin`.
 *
 * Google Fonts is on this list under protest. styles.css:1 @imports the CSS2
 * endpoint, so the four brand families are fetched from a third-party CDN at
 * test time — which means the fonts, and therefore the pixels, are an input this
 * repo does not version. Self-hosting them is the real fix; until then the guard
 * below at least makes any change to what gets rasterised fail loudly instead of
 * quietly moving 78 baselines.
 */
const ALLOWED_OFF_ORIGIN = ["fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * Abort every off-origin request except the font CDN.
 *
 * Found while triaging the first CI run: nothing stopped the built bundle from
 * talking to the real internet during a pixel test. /app/login constructs a
 * Supabase client from VITE_SUPABASE_URL and its auth code calls out on mount —
 * so the login baseline was partly a photograph of a live third-party response,
 * with its latency inside the screenshot timing. blockApi only ever matched
 * `**​/api/**`, which Supabase's `/auth/v1/*` does not.
 *
 * CALL THIS AFTER blockApi, AND NOTE THE fallback() CALLS — BOTH ARE LOAD-BEARING.
 * Playwright matches route handlers last-registered-first, and `route.continue()`
 * performs the request immediately without consulting any earlier handler. A
 * `**​/*` handler that calls continue() therefore silently disables every route
 * registered before it. Measured against a static server that answers /api/* with
 * the SPA index, exactly like `vite preview` does:
 *
 *   continue()  ->  /api/ping = 200 (SPA index HTML)   <- blockApi dead
 *   fallback()  ->  /api/ping = aborted                <- blockApi honoured
 *
 * and the font CDN reaches the network in both. `fallback()` defers to the next
 * matching handler and, when none is left, performs the request as if unrouted —
 * which is what the allowlist wants.
 */
export async function blockOffOrigin(page: Page, pageOrigin = "localhost") {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return route.fallback();
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return route.fallback();
    }
    if (host === pageOrigin || host === "127.0.0.1" || host === "::1") return route.fallback();
    if (ALLOWED_OFF_ORIGIN.includes(host)) return route.fallback();
    return route.abort();
  });
}

export type FontProvenance = {
  /** Families Chromium actually rasterised that are NOT webfonts. */
  systemFonts: Array<{ family: string; glyphs: number; sampleText: string; cssFamily: string }>;
  /** Webfont families that were used. */
  webFonts: string[];
};

/**
 * Report which fonts a page ACTUALLY rasterised, via CDP
 * CSS.getPlatformFontsForNode — the only way to see past the CSS font stack to
 * the file Chromium chose.
 *
 * WHY A SCREENSHOT SUITE NEEDS THIS
 * A generic family (`serif`, `ui-serif`, `system-ui`, `monospace`) resolves
 * through fontconfig to whatever the operating system has. That makes the
 * baseline an artifact of the distro, not of the product. It is invisible in
 * review — the class looks fine, the shot looks fine, and it only surfaces the
 * first time the suite runs somewhere else.
 *
 * It cost 36 of the 51 failures on the first CI run:
 * dashboard-shell.tsx used Tailwind's stock `font-serif`
 * (ui-serif, Georgia, Cambria, "Times New Roman", Times, serif — not one webfont
 * in it), so the admin "Weeber" wordmark rasterised from Caladea on Debian and
 * from something else on ubuntu-24.04. Nobody had noticed the admin panel was
 * not using the brand typeface at all.
 */
export async function fontProvenance(page: Page): Promise<FontProvenance> {
  const ids = await page.evaluate(() => {
    let i = 0;
    const out: string[] = [];
    document.querySelectorAll("*").forEach((el) => {
      const ownsText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
      );
      if (!ownsText) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const id = `fp-${i++}`;
      el.setAttribute("data-font-probe", id);
      out.push(id);
    });
    return out;
  });

  const ctx = page.context();
  const client = await ctx.newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const doc = (await client.send("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } };

  const system = new Map<string, { family: string; glyphs: number; sampleText: string; cssFamily: string }>();
  const web = new Set<string>();

  for (const id of ids) {
    let nodeId: number | undefined;
    try {
      const q = (await client.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: `[data-font-probe="${id}"]`,
      })) as { nodeId: number };
      nodeId = q.nodeId;
    } catch {
      continue;
    }
    if (!nodeId) continue;
    let fonts: Array<{ familyName: string; isCustomFont: boolean; glyphCount: number }> = [];
    try {
      const pf = (await client.send("CSS.getPlatformFontsForNode", { nodeId })) as {
        fonts: typeof fonts;
      };
      fonts = pf.fonts ?? [];
    } catch {
      continue;
    }
    for (const f of fonts) {
      if (f.isCustomFont) {
        web.add(f.familyName);
        continue;
      }
      const info = await page.evaluate((probeId: string) => {
        const el = document.querySelector(`[data-font-probe="${probeId}"]`) as HTMLElement | null;
        if (!el) return { text: "", cssFamily: "" };
        return {
          text: (el.textContent ?? "").trim().slice(0, 60),
          cssFamily: getComputedStyle(el).fontFamily,
        };
      }, id);
      const key = `${f.familyName}::${info.cssFamily}`;
      const existing = system.get(key);
      if (existing) existing.glyphs += f.glyphCount || 1;
      else
        system.set(key, {
          family: f.familyName,
          glyphs: f.glyphCount || 1,
          sampleText: info.text,
          cssFamily: info.cssFamily,
        });
    }
  }

  await client.detach().catch(() => {});
  await page.evaluate(() =>
    document.querySelectorAll("[data-font-probe]").forEach((el) => el.removeAttribute("data-font-probe")),
  );

  return { systemFonts: [...system.values()], webFonts: [...web].sort() };
}

/** Pin the product theme. Read from localStorage by lib/theme.ts. */
export async function presetTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["weeber_theme", theme] as const,
  );
}

/**
 * Wait for the app to have MOUNTED, then for fonts, layout and paint.
 *
 * `document.fonts.ready` matters because web fonts land after first paint, and a
 * shot taken before they do captures fallback metrics — different glyph widths,
 * different wrapping, different element heights. That alone produces a diff on
 * every second run.
 *
 * WHY THE MOUNT WAIT EXISTS (added after the first CI run)
 * This used to poll `document.fonts.status === "loaded"` as its only gate, which
 * is a race, not a wait: `status` is "loaded" whenever nothing is *currently*
 * pending, and immediately after `domcontentloaded` that includes the moment
 * before the stylesheet has been parsed and the first @font-face requested. So
 * settle() could return against an empty `#root`.
 *
 * It stayed invisible in visual.spec.ts because `toHaveScreenshot` re-shoots
 * until two consecutive frames match, which accidentally waits for React. The
 * single-shot suites had no such luck: a11y and font-provenance read the DOM
 * exactly once. Measured on /app/login — three consecutive runs of
 * font-provenance saw 0, 0 and 10 text-owning elements on the same build, and
 * axe reported 6 rules applied against a floor of 12 on a page that renders a
 * full sign-in form. Any assertion about a page is worthless if the page might
 * not be there yet.
 */
export async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      if (!root || root.children.length === 0) return false;
      // Rendered text, not just a mounted shell: every screenshotted route has
      // copy on it, so "no text" means React has not painted its tree yet.
      return (document.body.innerText ?? "").trim().length > 0;
    },
    null,
    { timeout: 20_000 },
  );
  // `fonts.ready` is a promise, so unlike `.status` it cannot report done early:
  // by this point the app has painted, so every @font-face it needs is requested.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Two frames: one for the layout the fonts just changed, one for it to paint.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(150);
}

/** Wait for a harness page to report that it mounted, then settle. */
export async function settleHarness(page: Page, key: string) {
  await page.waitForSelector(`[data-harness="${key}"]`, { timeout: 20_000 });
  await settle(page);
}
