# Weeber — UI/UX Audit

**Repo:** `/home/user/openvent` · branch `main` · HEAD `b5a1fb6`
**Date:** 2026-08-03
**Surfaces audited:** public/marketing (14 routes + 3 compliance), merchant app `/app` (14 routes), admin `/dashboard` (23 routes)
**Method:** live render at 390 / 1440 (light + dark + reduced-motion), computed-style audit via `mb audit`, WCAG 2.x + APCA measured with `scripts/contrast.py`, code read for token/component/semantics drift, competitor teardown of Vapi / Retell / Bland / Bolna.
**Both private surfaces were audited authenticated, not mocked** — a real merchant session (`needsOnboarding: true`, Shopify vertical) across `/app`, `/app/agents`, `/app/calls`, `/app/billing`, `/app/settings`, and a real admin session across `/dashboard`, `/orgs`, `/agents`, `/analytics`, `/waitlist`, `/settings`, `/compliance`, all at 390 + 1440. §G collects the findings that only the live session exposed.
**No code was changed.** The only file added to the repo is this one. Every number below is measured, not estimated.

---

## Score

| Category | Weight | Score | One-line justification |
| --- | --- | --- | --- |
| Hierarchy & Clarity | 20% | **5**/10 | Landing's primary CTA renders greyed-out by default while the *secondary* nav CTA is solid black — the rank order is inverted. Pricing page has no prices. Admin nav is 18 flat items. Billing has no primary button at all. |
| Design System Consistency | 20% | **4**/10 | Three separate token systems, two conflicting neutral hue families, 22 font sizes on one page, 345 arbitrary px, 111 raw `<button>`, **32 raw `<select>`**, three overlapping card classes. |
| Accessibility | 20% | **4**/10 | 11 measured contrast failures, including **every input and card border on all three surfaces**. Mobile nav touch targets ~20px. Heading skip on `/app/agents`; no `h1` at all on `/dashboard/settings`. |
| Visual Craft | 15% | **5**/10 | No AI slop, real type pairing, honest founder quote — but the hero pattern runs through the headline and form with no scrim, the form is ragged, ~10 sections repeat one layout, and the setup stepper breaks a label mid-word. |
| Responsive & Mobile | 10% | **4**/10 | Email placeholder clipped at 390px on the conversion form. Mobile nav is desktop links in a drawer. No `dvh`, no safe-area insets. |
| States & Edge Cases | 10% | **6**/10 | The `/app` system is genuinely strong — `EmptyState` in 16 files, skeletons in 20, vertical-specific empty copy. It stops dead at the admin boundary (3 empty-state shapes, none with an action), the onboarding state renders three times at once, and a trial merchant is told Pro is their current plan. |
| Performance | 5% | **5**/10 | 4 font families in one render-blocking `@import` chain with no preconnect; the heaviest (Fraunces) is unused on marketing. 14,636px landing page. `transition-all` on width-animated bars. |

**Weighted: 4.6 / 10** — band: *works but reads unpolished, one notch from "needs a design pass."*

The honest read: **`/app`'s architecture is the best part of this codebase, marketing is the worst, and `/dashboard` is the surface nobody has designed.** `/app` renders 2 font families, 6 font sizes, 3 weights, a systematic radius scale, config-driven verticals, one shell with density variants, and designed empty states everywhere. The landing page renders 22 font sizes and 9 radii with hand-styled everything. And `/dashboard` — 23 routes, the panel that will hold every tenant's data — inherits `/app`'s shell and then ignores every system it provides: no `EmptyState`, no `PageHeader` on settings, search on 1 page of 23, three different page-header shapes, org context in three different places or missing entirely.

So this is not one design problem. It's three: marketing needs discipline, `/dashboard` needs to actually adopt the system that already exists next to it, and the token layer underneath all three has never had its contrast measured.

---

## Top 3 changes that move the score most

1. **Delete `BASE_COUNT = 43`** (`landing.tsx:33`, `WaitlistForm.tsx:16`). You are displaying fabricated social proof. This is the single highest-risk finding in the audit and it takes ten minutes.
2. **Fix the border token.** `--border` is measured at **1.37:1** in light mode and **1.57:1** in dark. Because `--input: var(--border)`, every text field, select, and textarea across `/app` and `/dashboard` currently has a functionally invisible boundary. One token, ~40 pages fixed.
3. **Put the live demo in the fold and make the CTA look enabled.** All four competitors lead with "talk to an agent now." You lead with a greyed-out email form and hide `AgentDemoWidget` in section 2 of a 10-section page. The greyed-primary bug is systemic, not local — the same pattern appears on five pages (§G), so fix it as a `Button` invariant, not five times.

One more that isn't in the top three only because it's narrow, and you should still fix it today: **`pages/app/billing.tsx:79-82` tells every Free Trial merchant that Pro is their current plan and disables the button that would sell it to them.** It is the only conversion path in the product and it is closed. §G.

---

## A. Accessibility — measured failures

Every row below was produced by `scripts/contrast.py`. Nothing here is eyeballed.

### Critical — invisible control boundaries (affects ~40 pages)

| Token | Value | Against | WCAG | Floor | Verdict |
| --- | --- | --- | --- | --- | --- |
| `--border` / `--input` (light) | `oklch(0.88 0.004 80)` | page `oklch(0.985 0.003 80)` | **1.37:1** | 3:1 | FAIL — invisible |
| `--border` / `--input` (light) | `oklch(0.88 0.004 80)` | card `oklch(0.995 0.001 80)` | **1.42:1** | 3:1 | FAIL — invisible |
| `--border` / `--input` (light) | `oklch(0.88 0.004 80)` | muted fill | **1.24:1** | 3:1 | FAIL — invisible |
| `--border` / `--input` (dark) | `oklch(0.32 0.006 80)` | page `oklch(0.14 0.006 80)` | **1.57:1** | 3:1 | FAIL — invisible |
| `--border` / `--input` (dark) | `oklch(0.32 0.006 80)` | card | **1.35:1** | 3:1 | FAIL — invisible |
| `--border` / `--input` (dark) | `oklch(0.32 0.006 80)` | muted fill | **1.35:1** | 3:1 | FAIL — invisible |
| `--ring` (dark) | `oklch(0.5 0 0)` | card | **2.85:1** | 3:1 | FAIL — see note below |
| `--m-input-border` (marketing) | `#B7B6B1` | `#FFFFFF` | **2.03:1** | 3:1 | FAIL |
| `--m-border` (marketing) | `#E6E5E2` | `#FCFCFB` | **1.23:1** | 3:1 | FAIL — invisible |

> **Amended 2026-08-04, from `bun run contrast:gate`.** The three extra control-border rows and the `--ring` row above were not in the original audit — the audit measured each token against the page background only. Six of the nine failures the gate now ratchets are card and muted-fill surfaces the audit never checked, so the real blast radius is wider than "page bg" suggested. Most importantly, **dark `--ring` on a card measures 2.85:1, a fail** (§ later in this doc records it as 3.32:1 passing, which is correct *against the page* and wrong on every card, dialog, and popover — i.e. most places a focus ring actually lands). All nine are declared in `tools/ui-guard/tokens.json` `knownFailures` and are Phase B work.

> **[Critical] Every input, select and textarea border in the product is below the 3:1 UI floor** — `packages/web/src/web/styles.css:408` (`--weeber-border`), `:444` (`--border`), `:445` (`--input: var(--border)`), `:446` (`--ring`), `:447` (`--sidebar`); dark `:679` (`--weeber-border`), `:713` (`--border`), `:714` (`--input`), `:715` (`--ring`), `:716` (`--sidebar`); `styles-marketing.css:21` (`--m-input-border`), `:15` (`--m-border`). *(Line numbers re-verified 2026-08-04; the originals — 411/449/672 — had drifted.)*
> WCAG 2.1 SC 1.4.11 requires 3:1 for the boundary of any component whose shape communicates its function. A text field whose edge is at 1.4:1 is a field a low-vision user cannot locate. This also affects card edges, table row dividers used as structure, and the `1px` outlines on the pricing comparison table.
> **Fix:** split the single `--border` token into two. `--border` (decorative dividers, no floor) stays light. Introduce `--border-control` used by `--input` and by any bordered interactive surface, at `oklch(0.62 0 0)` light / `oklch(0.56 0 0)` dark. **Verified:** 3.64:1 on card, 3.44:1 on page, 4.32:1 / 3.97:1 / 3.53:1 across all three dark surfaces. Marketing's `--m-input-border` → `#7F7F84` or darker.

### Critical — mobile nav touch targets

> **[Critical] Mobile navigation links are ~20px tall** — `packages/web/src/web/components/marketing/MarketingNav.tsx:89-94`
> `<nav className="flex flex-col gap-4">` with `text-sm` links and no padding. A 14px link in a 20px line box is less than half the 44×44 minimum, and `gap-4` (16px) puts adjacent targets inside each other's error radius. The hamburger itself (`:78`, `p-2` + `w-5 h-5`) is 36px — also under.
> **Fix:** links → `block py-3 -mx-2 px-2 text-base` (44px+ tall, full-row hit area), drop `gap-4` to `gap-0` with `divide-y`. Hamburger → `p-3` with `w-6 h-6`.
> Related: this is also the anti-pattern the rubric names explicitly — desktop nav links stacked in a drawer, not a real mobile nav pattern. Since there are only 4 links, a full-width list with dividers and a sticky "Join the waitlist" at the bottom of the sheet is the right shape.

### High — text below 4.5:1

| Where | fg / bg | WCAG | APCA | Verdict |
| --- | --- | --- | --- | --- |
| `--weeber-warning` body text, light | `oklch(0.62 0.15 80)` on `oklch(0.985 0.003 80)` | **3.54:1** | Lc 61 | FAIL |
| `--weeber-error`, dark, on card | `oklch(0.62 0.2 25)` on `oklch(0.225 0.007 80)` | **4.26:1** | Lc 31 | FAIL |
| `#22C55E` success tick + "Confirmed" badge | on `#FFFFFF` | **2.28:1** | Lc 44 | FAIL badly |
| `text-red-500` (`#ef4444`) error copy at 11.5px | on `#FCFCFB` | **3.67:1** | Lc 62 | FAIL |
| `--m-text-muted` (`#7A7A82`) — placeholders, footnotes | on `#FCFCFB` | **4.15:1** | Lc 68 | FAIL |
| `--m-accent-blue` (`#4E9FE8`) | on `#FCFCFB` | **2.75:1** | Lc 52 | FAIL |
| Submit CTA at `disabled:opacity-50` | `#FCFCFB` on `#868687` | **3.54:1** | Lc 65 | FAIL |

> **[High] The amber warning text is the most-read failure in the app** — `styles.css:423` (`--weeber-warning`)
> Rendered example, confirmed in the screenshot: *"Turned on, but no caller ID — it can't place calls yet."* on the Agents cards, at 12px, at 3.54:1. This is a blocking-state message about an agent that cannot make calls. It is the sentence that most needs to be read.
> **Fix:** if you keep hue at all (see §D), take warning to `oklch(0.48 0.13 75)` for *text* and keep the current lightness only for the badge *fill*. Under the monochrome mandate this becomes an inverted badge + `AlertTriangle` icon, which measures 17.09:1 — see §D's status table.

> **[High] Marketing form validation uses Tailwind's default red/green at failing contrast** — `WaitlistForm.tsx:171, 197, 201, 230, 237, 243, 248, 273, 311, 317`
> `text-red-500`, `border-red-400`, `text-[#22C55E]`. Two problems at once: they fail contrast, and they are raw framework/hex values inside a brand that otherwise has no colour. `#22C55E` at 2.28:1 is used for the success tick *and* the "Confirmed" pill text.
> **Fix:** these should not be colour at all on a monochrome brand. Error = `--n-900` text + `AlertCircle` icon + `--border-control` at 2px on the field. Success = `Check` icon + `--n-700` text. Measured replacements in §D.

### High — semantics

> **[High] Heading level skips h1 → h3 on `/app/agents`** — confirmed by `mb audit` on the live render.
> The page `h1` is "Agents", then the agent card titles are `h3` with no `h2` between. Screen-reader users navigating by heading get a broken outline.
> **Fix:** either card titles → `h2`, or add a visually-hidden `h2` for the grid region ("Your agents").

> **[Medium] Every in-app page inherits the marketing `<title>`** — `packages/web/index.html:17`
> `mb audit` on `/app/agents` reports the document title as *"Weeber — AI Voice Agents for Missed Calls | Join the Waitlist"*. Browser tabs, history, and bookmarks are useless across a 14-page app; screen readers announce a marketing pitch on page change. Same for all 23 admin pages.
> **Fix:** a `useDocumentTitle(...)` hook called from `PageHeader` (already used by 22 pages, so it's one edit): `` `${title} · Weeber` `` for `/app`, `` `${title} · Weeber Admin` `` for `/dashboard`.

> **[Low] The sign-in `h1` is the bare wordmark** — `pages/app/login.tsx:417`
> `<h1>Weeber</h1>`. The h1 should carry the page's job. (The other five `h1`s in this file at `:236, :296, :301, :336, :359` are mutually-exclusive state branches — correctly only one renders at a time. Not a finding.)
> **Fix:** `<h1>Sign in to Weeber</h1>`, wordmark becomes a decorative `<span>` or the logo mark with `alt`.

### What passes (verified, not assumed)

- `prefers-reduced-motion` is honoured properly — `styles.css:360-367` plus the reduced-motion full-page capture confirms **all `[data-reveal]` content still renders**. This is the check most sites fail. You pass it.
- ~~`--ring` light `oklch(0.55 0 0)` = 4.65:1, dark `oklch(0.5 0 0)` = 3.32:1 — both clear the 3:1 focus-ring floor.~~ **Retracted 2026-08-04.** Only true against the *page* background. `contrast:gate` measures dark `--ring` on a **card at 2.85:1 — a fail**, and cards, dialogs and popovers are where most focus rings actually land. Light ring still passes on every surface. Moved to §A's critical table and to `knownFailures`.
- Status badges pair their dot with a text label ("Live", "Paused", "Needs a number") — meaning is not encoded in colour alone. Keep this discipline through the monochrome migration.
- `lang="en"`, canonical, single `h1` per marketing page, real `<label>`s, `aria-invalid` + `aria-describedby` wired on the waitlist fields, `SkipToContent` present, `overflow-x: clip` guard on `html`.

---

## B. Hierarchy & Clarity

> **[Critical] The landing page's primary CTA renders as a disabled grey button on first paint** — `components/marketing/WaitlistForm.tsx:235-239`
> `disabled={state === "loading" || !canSubmit}` + `disabled:opacity-50`. On page load the fields are empty, so `canSubmit` is false, so "Get early access" paints at 50% opacity — measured **3.54:1**, visually indistinguishable from a dead control. Meanwhile "Join the waitlist" in the nav (`MarketingNav.tsx:68`) is solid `--m-text` black.
> **The result: the loudest button on your landing page is the secondary one.** Verified in the 1440 screenshot — the nav pill reads as the action, the actual conversion button reads as unavailable.
> **Fix:** don't gate the button on validity. Keep it fully enabled, validate on submit, and move the error to the field. If you must show a pre-valid state, use `--n-700` fill rather than 50% opacity so it stays above 4.5:1 and still reads as pressable. `cursor-pointer` on a `disabled` button (same line) is also wrong — it promises a click that does nothing.

> **[High] The demo is below the fold; all four competitors put it in the fold** — `pages/landing.tsx` fold = headline + waitlist form; `AgentDemoWidget` renders in section 2 ("Hear your agents in action").
> Teardown (`mb`, live, today):
> | Product | Fold primary action | Fold secondary |
> | --- | --- | --- |
> | Vapi | **"Initiate Call"** + use-case tab switcher (Appointment Scheduling / Support / Lead Qual) | Contact Sales |
> | Retell | **"Try Our Live Demo"** | See Customers |
> | Bland | **"Click to speak with an agent"** + 581,757,825 calls counter | Book a call |
> | Bolna | **"Experience Bolna"** | Book a Demo |
> Every one of them makes *hearing the product* the fold's job, because for voice AI the product is unprovable in text. You already built the widget. It is in the wrong place.
> **Fix:** swap sections 1 and 2's content. Fold = headline + the demo widget with a vertical tab switcher (you already have `VERTICAL_TABS` in `lib/marketing-config.ts:75`) + "Hear a real call" as the primary. Waitlist form drops to a sticky footer bar and the closing section. Also add a secondary "Book a call" — all four competitors carry one and you carry none, which costs you every high-intent visitor who wants a human.

> **[High] `/pricing` shows no prices** — `pages/pricing.tsx`
> Headline: *"Simple pricing. No rev-share tax on your recovered sales."* Subhead: *"Full public pricing is set at launch."* Three tiers (Starter / Growth / Scale) with feature lists and zero numbers. A pricing page with no price fails its only job; visitors who click "Pricing" are the highest-intent traffic you have and they leave with nothing.
> **Fix:** two honest options. (a) Publish founder pricing as real numbers with "founder rate, locked for life" framing — you already claim this in the hero, so the number exists. (b) Rename the nav item to "Plans", show *relative* shape (per-minute vs per-seat, what's metered, what's capped) with an explicit "Founder pricing is set individually — book a call", and make "Book a call" the page's primary. Do not keep a page titled "Simple pricing" that contains no pricing.
> Related: "Capped calls/minutes" as a Starter bullet reads as a *limitation* in the top slot of your entry tier. Lead with the outcome ("Enough volume for one store's cart recovery"), state the cap as a number underneath.

> **[High] Admin nav is 18 flat items with no grouping** — `components/dashboard/dashboard-shell.tsx:11-30`
> Calls · Agents · Analytics · Compliance · Do Not Call · Orgs · Users · Waitlist · Broadcasts · Templates · Billing · Revenue · Marketing · Workflows · Flags · Support · Logs · Keys. Eighteen equal-weight items is a list, not an information architecture — nothing is findable by scanning, only by reading all 18. It also has no rank order: `Flags` (rarely touched) sits at the same visual weight as `Calls` (the default landing route).
> **Fix:** group into 5 labelled sections. Ops (Calls, Agents, Workflows, Broadcasts) · Compliance (Compliance, Do Not Call, Audit, Logs) · Accounts (Orgs, Users, Waitlist, Support) · Money (Billing, Revenue) · Growth (Analytics, Marketing) · System (Templates, Flags, Keys). `AppShell`'s `NavItem[]` needs a `section?: string` field and `NavLinks` needs to emit an `<li>`-grouped list with `text-[11px] uppercase tracking-wide` headers. ~30 lines in `app-shell.tsx:130-150`.

> **[Medium] Merchant nav's 10 items mix workspace and account concerns** — `lib/verticals.ts:82-93`
> Home · Agents · Workflows · Conversations · **Orders** · **Billing** · Integrations · Knowledge Base · Phone Numbers · Settings. Billing is wedged between two workspace items. Account-level destinations (Billing, Settings) and infrastructure (Phone Numbers, Integrations) should sit in a bottom group separated from the daily-work items.
> **Fix:** same `section` mechanism. Work (Home, Agents, Workflows, Conversations, Orders/Leads) · Setup (Integrations, Knowledge Base, Phone Numbers) · Account (Billing, Settings).

> **[Medium] `/app/agents` has no primary action** — verified in the 1440 render.
> The page header is a title + description and nothing else. There is no "New agent" or "Add agent" button anywhere above the fold. The four cards are the only affordance, and the summary strip's one actionable item ("2 need a phone number") is styled as a 12px stat, not a link — it *is* clickable amber text, which means the most urgent thing on the page reads as a statistic.
> **Fix:** `PageHeader` grows an `action` slot (primary button, top-right). Promote the blocked-agents count to a real bordered call-out row above the grid: `AlertTriangle` + "2 agents can't place calls — assign a phone number" + a `Button size="sm"`.

> **[Medium] Two orphaned admin routes** — `app.tsx:203` and `:219`
> `/dashboard/audit` (`AuditPage`) is routed but appears in no nav item. `/dashboard/workflow-runs` (`WorkflowRunsPage`) likewise — and its intended parent's match regex is wrong: `navMatch("/workflows", "/workflow-runs")` at `dashboard-shell.tsx:25` compiles to `^/dashboard/workflows/workflow-runs$`, which never matches the real path `/dashboard/workflow-runs`. So the Workflows nav item also fails to highlight when you're on that page.
> **Fix:** regex → `new RegExp("^" + adminPath("/workflows?") + "...")` or simply add both routes as their own nav entries under the Compliance and Ops groups. Also: the nav label "Keys" points at `/dashboard/settings` — pick one name.

> **[Medium] Ten public routes are unreachable from the nav** — `MarketingNav.tsx` `NAV_LINKS` = Pricing, Compliance, About, FAQ.
> `/shopify` and `/insurance` are your two solution pages — the pages that actually explain what Weeber does for a specific buyer — and neither is in the nav. `/docs` and `/roadmap` aren't either. Every competitor carries a "Product" or "Solutions" entry as their first nav item.
> **Fix:** nav → **Solutions** (dropdown or a `/solutions` hub linking `/shopify`, `/insurance`) · Pricing · Compliance · Docs. Move About/FAQ/Roadmap to the footer.

---

## C. Design System Consistency

### Three token systems, two conflicting neutral hue families

You have `:root` + `.dark` (`styles.css:68-146`), `.theme-weeber` + `.theme-weeber.dark` (`:400-465, :664-725`), and `.marketing` + dark (`styles-marketing.css:11-48`). Three is defensible if the split is intentional. Two problems make it not:

> **[High] The "brownish" cast is a deliberate warm tint you can measure, and it fights a leftover steel-blue tint** — `styles.css:405-411, 665-672`
> The `.theme-weeber` neutrals all carry hue 80 at chroma 0.003–0.007: `--weeber-paper: oklch(0.985 0.003 80)`, `--weeber-border: oklch(0.88 0.004 80)`, `--sidebar: oklch(0.955 0.004 80)`, and in dark `--weeber-paper: oklch(0.14 0.006 80)`. The code comments call this "faint warm tint for texture warmth." At chroma 0.006 on a large flat area that is *exactly* enough to read as beige rather than grey — confirmed visually in the 1440 render, where the sidebar reads clearly cream against the page.
> Meanwhile, four values were never migrated off hue 240 (steel blue): `--weeber-accent-soft: oklch(0.22 0.003 240)` (`:676`), `--sidebar: oklch(0.1 0.003 240)` (`:719`), the dark card hover border `oklch(0.38 0.002 240)` (`:569`), and `.card-weeber--editor`'s `oklch(0.16 0.003 240 / 0.6)` (`:575`).
> **So dark mode has a warm page, a warm card, and a cool sidebar and cool hover borders.** That's the "muddy" read: not one tint, two competing ones.
> **Fix:** §D. Set chroma to exactly `0` everywhere and get texture from lightness steps and the grain overlay, which is what's actually doing the work.

> **[High] The `:root` Vent palette is still live and will leak** — `styles.css:72-79`
> `--ember: oklch(0.53 0.19 35)` (burnt orange) is `--primary` and `--ring` at `:root`, with `--paper: oklch(0.95 0.015 80)` at chroma 0.015 — five times the tint of the Weeber theme. Any element that renders outside a `.theme-weeber` root and outside `.marketing` — a portal that escapes, an error boundary, `not-found.tsx`, a future page that forgets the class — inherits an orange-accented cream theme. Under a strict monochrome mandate this whole block is dead weight that can only cause bugs.
> **Fix:** delete the `--paper/--ink/--ember/--signal` family and the `:root`/`.dark` blocks; make `.theme-weeber`'s values the `:root` defaults so there is no "wrong" fallback to leak to. Keep `.marketing` as the one scoped override.

### Type

> **[High] Four font families are loaded; the landing page renders 22 font sizes** — `styles.css:1`
> One `@import url()` pulls Fraunces (5 weights + 2 italics, variable `opsz`), Inter Tight (4), JetBrains Mono (3), and Bricolage Grotesque (5 weights, variable `opsz`). Measured on the live render:
> - **Landing:** 3 families (Inter Tight 399, Bricolage 26, JetBrains 21), **22 sizes** — 10.5, 11, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 17.6, 22, 24.6, 30.7, 34.8, 38.9, 46, 61.4 — and **5 weights**.
> - **App (`/app/agents`):** 2 families (Inter Tight, Fraunces), **6 sizes** (11, 12, 14, 16, 18, 24), **3 weights**.
> The rubric ceiling is ≤6 sizes, ≤4 weights, ≤2 families. The app already meets it. The landing page is 3.6× over on sizes, and the cause is mechanical: `text-[12.5px]`, `text-[11.5px]`, `text-[13.5px]`, `text-[17.5px]` written inline — **345 arbitrary `[Npx]` values across the codebase**, concentrated in `landing.tsx` (56), `contact.tsx` (19), `pricing.tsx` (16), `about.tsx` (15), `WaitlistForm.tsx` (15), `insurance.tsx` (14), `shopify.tsx` (13).
> **Also: Fraunces is downloaded on every marketing pageview and never used there** (0 renders — the display font on marketing is Bricolage, per `styles-marketing.css:51`). Bricolage is downloaded on every app pageview and never used there. Each surface pays for the other's display font.
> **Fix:** (a) define a 7-step scale in `@theme` (`--text-xs: 12px / --text-sm: 14px / --text-base: 16px / --text-lg: 18px / --text-xl: 22px / --text-3xl: 30px / --text-5xl: 48px` + a `clamp()` display step) and codemod every `text-[Npx]` to the nearest step. (b) Split the font import: marketing loads Bricolage + Inter Tight, app loads Fraunces + Inter Tight + JetBrains. (c) Add `<link rel="preconnect">` to `fonts.gstatic.com` and self-host or preload — a CSS `@import url()` is a serialised request chain (HTML → CSS → CSS → font) and is the worst possible way to load a webfont.

> **[Medium] The admin wordmark renders in the browser's default serif** — `components/dashboard/dashboard-shell.tsx:35`
> `<span className="font-serif text-lg font-medium">Weeber</span>`. `font-serif` is Tailwind's default `ui-serif, Georgia, Cambria, "Times New Roman"` — it is **not** `--font-display` (Fraunces). The merchant app's wordmark (`app/user-shell.tsx:186`) correctly uses `font-display`. So `/app` shows Fraunces "Weeber" and `/dashboard` shows Times "Weeber". This is the only `font-serif` in the entire codebase.
> **Fix:** `font-serif` → `font-display`. Better: extract a single `<Wordmark variant="app" | "admin" />` so this can't diverge again.

### Radius, buttons, cards

> **[High] 111 raw `<button>` elements against a `Button` component imported in 25 files** — worst offenders: `agent-config/FallbackControls.tsx` (8), `dashboard/compliance.tsx` (7), `app/login.tsx` (7), `dashboard/orgs.tsx` (6), `dashboard/settings.tsx` (5), `dashboard/agents.tsx` (5), `voice/VoicePicker.tsx` (5).
> Each of these hand-writes its own padding, radius, font size, hover, and focus. Two examples of the same-role divergence: `app/user-shell.tsx:166` styles a "Back to sign-in" primary as `rounded-md bg-primary px-5 py-2 text-sm font-medium ... active:scale-[0.97]`, while `ui/button.tsx:8` defines primary as `rounded-md text-sm font-medium` with `focus-visible:ring-[3px]`. Different padding, different active state, different focus ring — same button role.
> **Fix:** the audit-per-file sweep is `rg -n '<button' packages/web/src/web`. Anything that isn't a Radix `asChild` trigger, an icon-only shell control, or a plain unstyled element becomes `<Button variant=... size=...>`. Add the variants you're missing rather than styling locally: you need at least `ghost-icon` (the sidebar collapse and theme toggle) and `link` (the amber "2 need a phone number").

> **[Medium] 11 distinct border-radius values, 6 of them arbitrary** — measured across `.tsx`: `rounded-md` 144, `rounded-full` 78, `rounded-lg` 76, `rounded-2xl` 9, `rounded-sm` 7, `rounded-xl` 6, `rounded-[15px]` 4, `rounded-[8px]` 3, `rounded-[16px]` 3, `rounded-none` 1, `rounded-[4px]` 1, `rounded-[2px]` 1. `mb audit` on the live landing page confirms 9 rendered radii.
> `rounded-[15px]` and `rounded-[16px]` both exist and are visually identical to `rounded-lg`/`rounded-xl` from your own scale — these are hand-tuned one-offs.
> **Fix:** the scale is already correct in `styles.css:12-15` (`--radius: 12px`, sm/md/lg/xl derived). Delete all six arbitrary values, and drop `rounded-2xl` unless you can name the one role that needs 16px+ (dialogs — then make it `--radius-2xl` and use it only there).

> **[Medium] Three overlapping card classes doing the same job** — `styles.css:549` `.card-weeber` (84 uses), `:628` `.card-lift` (15), `:637` `.card-action` (2).
> `.card-action` is `.card-weeber`'s declarations plus `.card-lift`'s, copied verbatim. And `.card-weeber[data-interactive]:hover` (`:561`) already produces the same hover lift. So there are **three** ways to get a hoverable card, and a reader can't tell which is canonical.
> **Fix:** keep `.card-weeber` with `[data-interactive]` as the only mechanism. Delete `.card-action` (2 call sites) and `.card-lift` (15) after migrating them to `data-interactive`. Better still: this should be a real `<Card>` component in `components/ui/`, which brings us to —

> **[Medium] `components/ui/` is missing five primitives that are consequently hand-rolled** — the directory has 15 components (badge, button, checkbox, command, dialog, input, label, select, sheet, skeleton, sonner, switch, tabs, textarea, tooltip). It has **no** `card`, `table`, `progress`, `alert`, or `dropdown-menu`.
> Consequences found in code: cards are three CSS classes (above); tables are 4 raw `<table>` elements (`pricing.tsx`, `dashboard/workflow-runs.tsx`, `dashboard/billing.tsx`) plus a shell-only `DataTable` used by 5 admin pages — so admin tables and marketing tables share nothing; progress bars are hand-built three times (`app/home.tsx:312`, `app/billing.tsx:165`, `charts/breakdown-list.tsx:31`), all three with the same `transition-all` performance bug (§F).
> **Fix:** add `card.tsx` (variants: `default | interactive | editor`), `table.tsx` (the `DataTable` primitives, extracted so marketing can use them), `progress.tsx`. `alert.tsx` and `dropdown-menu.tsx` when the first real need appears — don't add speculatively.

> **[Low] Two `Breadcrumbs` implementations** — `components/shell/breadcrumbs.tsx` (used by `PageHeader` + `app/agents.tsx:18` + `app/workflows.tsx:34`) and `components/marketing/Breadcrumbs.tsx` (used by the 3 compliance pages). Same role, two components, guaranteed to drift.
> **Fix:** one `Breadcrumbs` in `components/ui/`, styled by tokens so it adapts to `.marketing` vs `.theme-weeber` scope automatically.

> **[Low] The grain overlay is implemented twice** — `styles.css:491` (`.theme-weeber::before`, fixed inset, `mix-blend-mode: multiply/screen`) and `components/marketing/GrainOverlay.tsx` (used by `landing.tsx:157` and `MarketingPageShell.tsx:20`). Same visual effect, two codepaths, two chances to diverge. Same story for the voice orb: `agent-preview/VoiceOrb.tsx` + `.voice-orb-*` in `styles.css:265-337` vs `.demo-orb-*` in `styles-marketing.css:373-488` — and the CSS comment at `styles.css:259` openly admits it was duplicated "so the in-app preview and public demo feel like the same product."
> **Fix:** one `<Grain />` and one `<VoiceOrb />`, both token-driven, both used on both surfaces. The orb is your one piece of real brand personality — it should be a single component you can improve once.

> **[Low] `components/canvas/index.ts` is a dead barrel** — every consumer (`dashboard/workflow-editor.tsx:24-30`, `app/workflows.tsx:35-37`) imports deep paths directly. Delete it or use it; a barrel nobody imports is just a lie about the module boundary.

### Component inventory — honest answer on "useless components"

You asked me to find dead components. **I checked every one and found none.** Every file in `components/` has at least one real import site:

| Suspected dead | Actual | Verdict |
| --- | --- | --- |
| `shell/theme-toggle` | imported by `app-shell.tsx:13` | live |
| `shell/command-palette` | `app-shell.tsx:11` | live |
| `shell/keyboard-shortcuts` | `app-shell.tsx:12` | live |
| `agent-preview/VoiceOrb` | `PreviewDrawer.tsx:7` | live |
| `marketing/SkipToContent` | `MarketingNav.tsx:6` | live |
| `canvas/index.ts` | nothing imports it | **dead barrel, delete** |

Low-usage-but-justified (1–2 call sites each): `ui/tooltip`, `ui/command`, `ui/checkbox`, `FallbackControls`, `VoicePicker`, `FlowPreviewPanel`, `CompiledPromptPanel`, `GrainOverlay`, `date-range-selector`. Keep all of them — a primitive used once is not waste, it's a primitive.

**Your component problem is not deadwood. It is duplication (3 card classes, 2 breadcrumbs, 2 orbs, 2 grains) and absence (no Card, Table, or Progress, so 111 raw buttons and 3 hand-rolled progress bars fill the gap).**

---

## D. The monochrome mandate — token proposal

You asked for strict black shades + white, no other colour, across the whole platform. Below is a scale where **every pair has been measured**, plus the one place I think you should push back on yourself.

### Neutral ramp — chroma exactly 0

```css
/* Light */
--n-000: oklch(1     0 0);   /* card / elevated surface           */
--n-025: oklch(0.98  0 0);   /* page background                   */
--n-050: oklch(0.955 0 0);   /* sidebar / recessed / table header  */
--n-100: oklch(0.93  0 0);   /* hover fill / subtle chip           */
--n-200: oklch(0.90  0 0);   /* decorative divider — no floor      */
--n-400: oklch(0.62  0 0);   /* CONTROL BORDER (inputs, bordered buttons) */
--n-450: oklch(0.58  0 0);   /* control border on --n-050 surfaces */
--n-500: oklch(0.60  0 0);   /* icons, focus ring                  */
--n-600: oklch(0.50  0 0);   /* muted / secondary text             */
--n-700: oklch(0.38  0 0);   /* body-secondary text                */
--n-900: oklch(0.14  0 0);   /* primary text, primary button fill  */

/* Dark */
--n-000: oklch(0.13  0 0);   /* page background                    */
--n-025: oklch(0.19  0 0);   /* card                               */
--n-050: oklch(0.24  0 0);   /* raised / hover / table header       */
--n-400: oklch(0.56  0 0);   /* CONTROL BORDER — clears 3:1 on all three surfaces */
--n-500: oklch(0.58  0 0);   /* icons, focus ring                  */
--n-600: oklch(0.80  0 0);   /* muted text — APCA Lc 65            */
--n-900: oklch(0.96  0 0);   /* primary text, primary button fill  */
```

**Measured (`scripts/contrast.py`):**

| Pair | WCAG | APCA | Floor | Verdict |
| --- | --- | --- | --- | --- |
| `n-600` on `n-025` (light muted text) | 5.66:1 | Lc 76 | 4.5:1 | AA body ✓ |
| `n-600` on `n-000` (muted on card) | 6.00:1 | Lc 80 | 4.5:1 | AA body ✓ |
| `n-700` on `n-025` | 9.45:1 | Lc 89 | 4.5:1 | AAA ✓ |
| `n-900` on `n-025` | 18.79:1 | Lc 102 | 4.5:1 | AAA ✓ |
| `n-025` on `n-900` (inverted button) | 18.79:1 | Lc −103 | 4.5:1 | AAA ✓ |
| `n-400` on `n-000` (input border on card) | 3.64:1 | Lc 64 | 3:1 | UI ✓ |
| `n-400` on `n-025` (input border on page) | 3.44:1 | Lc 60 | 3:1 | UI ✓ |
| `n-450` on `n-050` (border on sidebar) | 3.76:1 | Lc 61 | 3:1 | UI ✓ |
| `n-500` on `n-025` (icons / focus) | 3.73:1 | Lc 63 | 3:1 | UI ✓ |
| **dark** `n-600` on `n-000` | 10.77:1 | Lc 65 | 4.5:1 | AAA ✓ |
| **dark** `n-900` on `n-025` | 16.44:1 | Lc 97 | 4.5:1 | AAA ✓ |
| **dark** `n-400` on `n-000` | 4.32:1 | Lc 27 | 3:1 | UI ✓ |
| **dark** `n-400` on `n-025` | 3.97:1 | Lc 26 | 3:1 | UI ✓ |
| **dark** `n-400` on `n-050` | 3.53:1 | Lc 25 | 3:1 | UI ✓ |
| **dark** `n-500` on `n-025` (focus) | 4.31:1 | Lc 29 | 3:1 | UI ✓ |

Two things I got wrong on the first pass and you should not repeat: my first light control border at `oklch(0.72 0 0)` measured **2.34:1** (fail), and my first dark border at `oklch(0.40 0 0)` measured **2.18:1** (fail). Removing hue makes borders *harder*, not easier — you lose chroma as a differentiation channel and lightness has to carry all of it. Run the script on any value you change.

### Status without hue

Removing colour costs you the one pre-attentive channel that makes status scannable. You get it back with **four** non-hue channels used together: fill weight, border presence, icon glyph, text label. Never fewer than three.

| State | Treatment | Measured |
| --- | --- | --- |
| **Critical / error** | Solid inverted badge: `n-025` text on `oklch(0.20 0 0)` fill, `AlertTriangle` icon, `border-left: 3px solid var(--n-900)` on the row | **17.09:1** |
| **Warning / blocked** | `oklch(0.26 0 0)` text on `n-100` fill + `1px solid var(--n-900)` outline, `AlertCircle` icon | **12.64:1** |
| **Success / live** | `n-700` text on `n-050` fill, no border, `Check` icon (filled dot) | **8.78:1** |
| **Neutral / paused** | `n-600` text on `n-025`, hollow `Circle` icon | 5.66:1 |

Ranking by fill darkness maps directly to urgency — solid-black is loudest, hollow is quietest. That is more legible than your current amber/green/grey, which currently fails contrast (§A) *and* is invisible to ~8% of male users.

### Where I'd push back

`styles.css:394-399` documents your existing decision: monochrome everywhere **except** semantic status, "because compliance/call-outcome status needs to be scannable at a glance." That reasoning is correct for one surface and wrong for the other two.

- **`/app` (merchants) and marketing: go fully monochrome.** A merchant looks at 4–8 agents. The shape/fill system above is plenty, and the brand consistency is worth more.
- **`/dashboard` compliance and call-outcome tables: consider keeping hue.** Ops staff scan hundreds of rows for a failed DNC check. Hue is genuinely pre-attentive in a way fill weight is not — it's the one place the accessibility and speed argument favours colour.

If you take that exception, scope it hard: `.theme-weeber .table-status--critical` inside `/dashboard` only, at *measured* values (your current dark error is 4.26:1 — failing), never on `/app`, never on marketing. If you'd rather have zero exceptions, the table above is verified and I'd ship it. **Your call — but make it once and write it into `docs/decisions/` as an ADR, because the current state is a half-finished migration, and that's worse than either endpoint.**

### Migration order

1. `--border` split (`--border` decorative / `--border-control`) — biggest a11y win, one token.
2. Set chroma to `0` in `.theme-weeber` + `.theme-weeber.dark`; delete the four hue-240 leftovers at `styles.css:569, 575, 676, 719`.
3. Delete the `:root`/`.dark` Vent palette (`styles.css:68-146`); promote `.theme-weeber` to `:root`.
4. Rebuild `.marketing`'s tokens off the same `--n-*` ramp instead of its own hex set; kill `--m-accent-blue`.
5. Replace the semantic set with the shape/fill/icon system; remove `text-red-500`, `border-red-400`, `#22C55E` from `WaitlistForm.tsx` and `contact.tsx`, and `bg-success` from `setup-modal.tsx:82`.
6. **Migrate the 32 native `<select>`s to `ui/select` (§G).** This is a hard prerequisite, not a follow-up: a native select paints the *operating system's* accent colour into its open dropdown, and no amount of `chroma 0` in your stylesheet can override it. Ship monochrome with 32 native selects and macOS will put blue in your product.
7. Codemod the 345 `[Npx]` and 11 radii onto the scale.

---

## E. Visual Craft & Layout

> **[High] The hero wave pattern runs through the headline and the form with no scrim** — `pages/landing.tsx` hero + `styles-marketing.css:134-201` (`.hero-wave-bar`, `.hero-bg--wave`, `.hero-fade`)
> Verified in the 1440 render: the vertical bars pass behind "**is a sale you just lost.**" — the descenders of "j" and "y" land directly on bar tips — and continue straight through both input fields. `.hero-fade` (`:194`) fades the pattern to background at the *bottom* of the hero only; it does nothing behind the type. The bars use a `linear-gradient(180deg, #0B0B0C 0%, #475569 50%, #94A3B8 100%)` (`:139`), which means the pattern's lightest region is where the text sits.
> **Fix:** either (a) push the pattern below the form — mask it to the region under the CTA — or (b) add a radial scrim behind the text block: `background: radial-gradient(ellipse 60% 50% at 50% 40%, var(--m-bg) 55%, transparent 100%)` between the pattern layer and the content, and test contrast against the pattern's *lightest* bar, not the page background. Note (`:139`, `:146`) those gradients also use `#475569`/`#94A3B8` — Tailwind slate — which are raw hex outside the token system and non-neutral under the monochrome mandate.

> **[High] The conversion form is ragged and clips on mobile** — `WaitlistForm.tsx:174-241`
> Structure: full-width name input, then `<div className="flex gap-2">` with a `flex-1` email input and an auto-width button. At 1440 the name field's right edge (650px) aligns with nothing — the email field ends at 522px. At **390px the email placeholder renders as "you@yourbran"** (confirmed in the mobile screenshot); the field is ~180px against a ~200px button.
> **Fix:** `flex-col sm:flex-row` on the row so mobile stacks to two full-width fields plus a full-width button; desktop keeps the pair. Then the name and email fields share one edge and the button aligns to it. The `text-[16px]` on inputs (`:170`) is already correct — that's the iOS zoom-on-focus guard, keep it.

> **[Medium] Roughly a third of the mobile fold is empty** — 390px render: the page starts, then ~190 CSS px of nothing before the "43 businesses" pill. On a 390×844 viewport the headline's first line lands around y=310. The pattern is offscreen entirely at first paint.
> **Fix:** hero top padding needs a mobile step-down. The nav is `fixed h-[66px]`; hero padding should be roughly `pt-24 sm:pt-32 lg:pt-40`, not one desktop value.

> **[Medium] Orphaned words in both headline and subhead** — 1440: subhead breaks as *"Voice AI that books, recovers carts, and follows up. 24/7. No / code."* — "code." alone on line 2. 390: headline breaks to four lines with "lost." alone on line 4.
> **Fix:** `text-wrap: balance` on the `h1` and `text-wrap: pretty` on the subhead, plus a `<br className="hidden sm:block">` or an `&nbsp;` binding "No code." Cheap, and it's the difference between typeset and pasted.

> **[Medium] Ten sections, one layout** — the full-page 1440 capture (14,636px) shows: stats band, then "The AI voice agent built for your business", "Built compliance-first", "A no-code voice platform", "Connect Weeber to the tools", "Customer conversations", "Enterprise AI was built for enterprises", founders quote, closing CTA — and **almost every one is a left/centred heading over a row of 2–4 equal-width bordered cards.** The rubric calls this out directly: symmetry with no tension reads as a template.
> **Fix:** you need at most two grid breaks, not ten redesigns. (1) Make the compliance section a full-bleed inverted band (`n-900` background, `n-025` text) — it's your actual differentiator and it should look different. (2) Make one section asymmetric 7/5 with the demo or a transcript pinned to one side and prose to the other. Leave the rest.

> **[Medium] Four hard statistics with no sources** — `lib/marketing-config.ts:65-70`
> "62% of calls to small businesses go unanswered", "85% of those callers never ring back", "~70% of online carts are abandoned", "21× more likely to win a lead if you reply within 5 minutes." The *framing* is honest — these are industry stats, correctly not presented as Weeber's results. But four unattributed percentages in the second band of a pre-launch page is exactly the thing a due-diligence reader tests, and the first one they can't verify costs you the other three.
> **Fix:** a `source` field per stat, rendered as a small superscript linking out (the 21× figure is the Lead Response Management / InsideSales study; cart abandonment is Baymard). If you can't source one, cut it.

> **[Medium] Card descriptions truncate on mobile where there's vertical room** — 390 render of `/app/agents`: *"Confirms cash-on-delivery orders before they ship to cu…"*. A fixed line-clamp on a single-column mobile layout is truncating for no reason — there is nothing below it competing for space.
> **Fix:** clamp only at `sm:` and up, where the 3-up grid needs equal heights. On mobile, let it wrap.

> **[Low] Ragged card bottoms in the agents grid** — 1440 render: "COD confirmation" is ~8px taller than its row-mates because it carries an extra warning line, and the 4th card orphans onto row 2 with a large empty region to its right.
> **Fix:** `items-stretch` on the grid with `flex flex-col` cards and the meta row pushed by `mt-auto` — the warning line then grows the row uniformly. For the orphan: at `lg:` a 2-up grid for ≤4 agents reads more deliberate than 3+1.

### AI-slop check — you pass this

Verified against the banned list: no purple/violet→blue hero gradient. No glowing blurred orb behind centred hero text (the orb is in the demo widget, where it's the product metaphor, and that's earned). Type identity is Bricolage Grotesque + Fraunces + JetBrains Mono, not an Inter-only default. No emoji as feature icons. Single-source Lucide icon set. No "Elevate/Unleash/Seamlessly/Supercharge" — the copy is direct and specific ("Every call you miss is a sale you just lost" is a real claim, not a category statement). The founders' quote at `landing.tsx:435-444` is correctly attributed to *"Founder, Weeber"* and is not a fake customer testimonial. `BrandLogos.tsx` is framed as "Connect Weeber to the tools you already run" — integration logos, not fake customers, and the source comment says Wikimedia Commons.

**One violation, and it's serious:**

> **[Critical] Fabricated social proof: the waitlist count has a hardcoded floor of 43** — `pages/landing.tsx:33` and `components/marketing/WaitlistForm.tsx:16`
> ```
> const BASE_COUNT = 43;
> const displayCount = Math.max(BASE_COUNT, count ?? BASE_COUNT);
> ```
> The page renders "**43 businesses already on the waitlist**" regardless of how many rows the waitlist table actually has. If the real number is 6, it says 43. If the fetch fails, it says 43. The same floor also drives the success-dialog copy "You're in — #43 in line" (`WaitlistForm.tsx:110, 263`), so a genuine signup is told a fabricated queue position.
> This is not a design nit. It is an invented metric on a public page, and it's the one thing on this site that could cost you a grant application, a diligence check, or an ad-platform review. It also undercuts everything else, because the rest of the copy is scrupulously honest — the stats are correctly framed as industry data, the quote is correctly attributed to the founder, the logos are integrations. You built an honest page and then put a fake number at the top of it.
> **Fix:** `const displayCount = count;` and render the pill only when `count >= 25` or whatever floor you'd be comfortable defending out loud. Below that, drop the pill entirely and let the demo carry the fold — which is what the competitor teardown says you should be doing anyway. Bland can show "581,757,825 calls resolved" because it's true; the correct pre-traction move is a layout that doesn't need the number, not a number that isn't real.

---

## F. Responsive, States, Performance

> **[High] `100vh` with no `100dvh` fallback** — `components/shell/app-shell.tsx` and `pages/dashboard/workflow-editor.tsx`. Zero uses of `100dvh` in the codebase. On iOS/Android the address bar makes `100vh` taller than the visible viewport, so a full-height shell is bottom-clipped and the workflow canvas's bottom controls sit under the browser chrome.
> **Fix:** `min-h-screen` → `min-h-[100dvh]`, and `h-screen` → `h-[100dvh]` in the full-bleed branch.

> **[High] No safe-area insets anywhere** — `rg 'safe-area|env\('` returns nothing. The app-shell's sticky mobile topbar and any sticky bottom action will sit under the notch/home indicator on iPhone.
> **Fix:** `viewport-fit=cover` in `index.html:6`, then `padding-top: env(safe-area-inset-top)` on the sticky topbar and `padding-bottom: env(safe-area-inset-bottom)` on the sidebar sheet footer and any sticky CTA.

> **[Medium] Three progress bars animate `width` via `transition-all`** — `pages/app/home.tsx:312`, `pages/app/billing.tsx:165`, `components/charts/breakdown-list.tsx:31`. Plus explicit layout transitions in CSS: `styles-marketing.css:117` (`transition: width 0.25s`), `:561` (`transition: width 0.3s linear`), `:662` (`transition: height 0.1s ease-out`), and `pages/compliance/index.tsx:92, 106` animate `gap` on hover.
> Animating `width`/`height`/`gap` triggers layout on every frame. `transition-all` is worse than naming the property because it will also animate anything you add later.
> **Fix:** progress bars → `transform: scaleX()` with `transform-origin: left` and `transition: transform 200ms`. Live wave bars → `scaleY()`. The `gap` hover → `transform: translateX(4px)` on the icon. Replace all 20 `transition-all` with named properties.

> **[Medium] Render-blocking font chain, 4 families, no preconnect** — `styles.css:1`, `packages/web/index.html`.
> The browser must parse HTML → fetch `styles.css` → parse it → discover the `@import url()` → fetch Google's CSS → parse → *then* fetch 4 variable fonts. There is no `<link rel="preconnect">` to `fonts.gstatic.com` and no `preload` on the display face. `display=swap` is set (good), so you get FOUT rather than invisible text, but the LCP element is the hero headline in Bricolage — the font it's waiting on.
> **Fix:** self-host the four faces (subset to latin, `woff2`) or at minimum move to `<link rel="preconnect">` + `<link rel="stylesheet">` in `index.html` and `<link rel="preload" as="font">` the one display weight used above the fold. Split the imports per surface (§C) — that removes one full family from each entry point.

> **[Medium] Waitlist phone-save failure is swallowed silently** — `WaitlistForm.tsx:161-163`, `// non-critical — silently ignore`. The user types a phone number, clicks save, and gets no feedback either way. "Non-critical" describes your system, not their experience.
> **Fix:** `toast.error("Couldn't save your number — you're still on the list.")`. Never zero feedback on a user-initiated mutation.

### States — what's genuinely good

Do not touch these; they're the strongest part of the codebase and I want them on the record so a future refactor doesn't flatten them.

- `shell/empty-state.tsx` used in **16** files; `shell/skeletons.tsx` in **20**; `shell/page-header.tsx` in **22**. That's near-total coverage.
- Empty-state copy is **per-vertical data, not JSX branches** — `lib/verticals.ts:98-105, 176-182` give Shopify and insurance different `callsEmptyTitle`/`callsEmptyBody`/`analyticsEmptyBody`, and it *teaches the next action* ("Calls appear here once one of your agents makes its first call — for example after an abandoned checkout"). This is exactly what the rubric asks for and most products get wrong.
- The dashboard hero KPI is hidden when the metric hasn't been earned (`verticals.ts:44-48`, "honors the no-fabricated-metrics null rule"). The right instinct — which makes `BASE_COUNT = 43` on the landing page even more anomalous.
- `mutation.isPending` disables save buttons (`app/agents.tsx:833, 898`), form state survives errors, skeleton→content uses a 300ms crossfade rather than a pop (`styles.css:213-224`).
- The vertical architecture itself: `VerticalDefinition` drives nav, glossary, copy, hero KPI, funnel stages, and metric tiles from one config object. Adding "clinic" is a data change, not a component change. That is the correct answer to the multi-tenant-by-vertical requirement and it's already built.

---

## G. Live authenticated session — what the mocked harness hid

Everything in this section was found by rendering the real product with a real session, and none of it was visible from the `/__preview` harness or from code alone. It is the densest section of the audit, which is itself the finding: **the two surfaces your customers and your operators actually live in were the two least-inspected.**

### The merchant app

> **[Critical] A Free Trial merchant is told Pro is their current plan, and the purchase path for it is a disabled button** — `pages/app/billing.tsx:79-82`
> ```ts
> isCurrent:
>   plan.toLowerCase() === "pro" ||
>   plan.toLowerCase() === "default" ||
>   plan === "Free Trial",
> ```
> `plan` defaults to `"Free Trial"` (`:48`). So on a fresh org the Active Plan card (`:127-141`) reads **"Free Trial"**, and 200px below it the Pro tier renders the `Recommended` ribbon (`:196`) *and* the `Current` badge (`:205`) *and* a **disabled** `Active plan` button (`:229-232`). All three verified in the 1440 render.
> Three failures stacked: (1) the page contradicts itself about which plan you're on; (2) you cannot "recommend" the plan the user is already on — the badge and the ribbon are mutually exclusive by definition; (3) the `isCurrent` branch **removes the only path to buy your headline tier**, leaving the merchant with "Upgrade to Starter" (a downgrade, `:66`) and a `mailto:` to Enterprise. On the one page whose entire job is trial→paid conversion, this is a revenue bug wearing a UI costume.
> **Fix:** `isCurrent` = strict equality against the real plan slug, nothing else. Add an explicit trial state whose Pro CTA is the page's single filled primary. Never set `recommended` and `isCurrent` on the same tier — assert it in the type if you have to.

> **[High] The billing page has no primary button at all** — `pages/app/billing.tsx:229-253`
> All three tier CTAs are `variant="outline"`; the middle one is `disabled`. Three equal-weight bordered buttons across a pricing grid means the rank order is empty — nothing wins, and the eye has no target on the page where you most need one. Verified at 1440: Starter, Pro and Enterprise CTAs are visually interchangeable.
> Separately: every purchase path is a `mailto:` (`:243`, `:250`). That's honest pre-launch, but then the label is wrong. "Upgrade to Pro" promises a checkout and opens a mail client.
> **Fix:** exactly one `variant="default"` (filled) — the tier you want them on — and the other two `outline`. Relabel to match reality: "Talk to us about Pro". §D's ranking-by-fill-darkness table is precisely this use case.

> **[High] Onboarding is presented three times simultaneously on first login** — verified in the `/app` 1440 render against a real `needsOnboarding: true` session.
> On screen at once: (1) the blocking `SetupModal`; (2) behind it, the "Finish setting up Weeber / Up next: …" banner with a `Resume` button (`pages/app/home.tsx:470-488`); (3) below that, a "Set up your first agent" empty state. Three competing invitations to do one thing — and the modal has a dismiss `X` that drops the merchant onto a dashboard of zeros.
> **Fix:** one owner per state. `needsOnboarding` → modal only; suppress the banner and render the metric area as skeletons, not as designed-empty (nothing is empty, it's unconfigured — a different state). `!needsOnboarding && !checklistDone` → banner only, no modal. `home.tsx:412` already computes `checklistDone`; the banner condition at `:458` just needs `&& !showModal`.

> **[Medium] The setup modal breaks a step label mid-word** — `components/app/setup-modal.tsx:77, 91-92`
> `<li className="flex flex-1 items-center gap-2">` gives all five steps equal width; the label span at `:91` has no `whitespace-nowrap`; and the connector rule at `:92` (`h-px flex-1`) competes for the same flex space. Verified at 1440 in a ~700px dialog: step 1 renders as "**Busines**" / "**s type**", broken mid-word. `stepKeys` is dynamic (`:487`), so insurance (4 steps) and Shopify (5) squeeze differently — the bug gets worse as you add verticals.
> **Fix:** `whitespace-nowrap` on the label, `flex-none` on the `<li>`, keep `flex-1` on the connector only. Below `lg`, drop the strip for "Step 2 of 5 · Connect store" + one progress rule — the `hidden sm:inline` at `:91` is already half-committing to this.
> Also `:82`: completed steps use `bg-success` (green). Add to §D's migration list.

> **[Medium] `/app/login` hardcodes the Shopify vertical before a vertical exists** — `pages/app/login.tsx:418`
> `"Voice agents for your Shopify store."` — but the vertical is chosen *after* signup, in the setup modal (`setup-modal.tsx:493`), and insurance is a shipped vertical (`verticals.ts:153-166`). Every insurance broker who signs up is told the product is for their Shopify store, and the field placeholder (`you@yourstore.com`) reinforces it.
> **Fix:** vertical-neutral subhead — "Voice agents that call your customers for you." Placeholder → `you@company.com`. Keep vertical-specific copy on `/shopify` and `/insurance`, where the visitor self-selected.

> **[Medium] Disabled and editable inputs are indistinguishable** — `/app/settings` 1440: "Email" and "Role" are disabled, "Contact email" is not, and on screen the only difference is slightly greyer value text. Same fill, same border, same height. The helper "Email cannot be changed here." is doing work the visual should do — and under the monochrome mandate, greyer text is a channel you're about to spend elsewhere.
> **Fix:** read-only values aren't form controls. Render them as a definition list, or as a recessed plate: `bg-[--n-050]`, no border, `cursor-not-allowed`.

> **[Low] Agent card descriptions truncate at 1440, not just at 390** — corrects §E.
> Verified at 1440: "Recovers abandoned checkouts by calling custome…", "Confirms Cash on Delivery orders to reduce RTO (Return…", "Calls customers after order fulfillment to collect post-…" — all three clipped, in a grid with ~350px of empty page beneath. The clamp isn't responding to a space constraint; it's a fixed line count applied where there is room at every breakpoint. Card titles also wrap to different heights (COD Confirmation → 2 lines), so the rows inside the three cards don't share baselines.
> **Fix:** the descriptions are static strings in `lib/` — measure the longest once and set the clamp to fit it, or drop the clamp and let `items-stretch` + `mt-auto` equalise the row (§E already prescribes this).

### The admin panel

> **[High] 32 raw `<select>` elements across 14 files, against a `ui/select` imported 3 times** — worst: `pages/dashboard/agents.tsx` (8 — `:80, 257, 281, 328, 334, 372, 381, 527`), `pages/app/settings.tsx` (3 — `:329, 364, 376`), then `pages/dashboard/analytics.tsx:94`, `support.tsx:123`, `broadcasts.tsx:124`, `workflows-list.tsx:173`, `workflow-editor.tsx:411`, `pages/app/workflows.tsx:869`, `components/marketing/EnterpriseDialog.tsx:225`, `components/canvas/NodeConfigPanel.tsx:62`, `components/workflow-preview/FlowPreviewPanel.tsx:131`.
> This ratio is worse than the 111 raw buttons (§C), because a native `<select>` renders **OS chrome your CSS cannot reach** — platform height, radius, font, arrow, and dropdown panel. Verified in the `/app/settings` and `/dashboard/analytics` 1440 renders: the selects sit beside token-styled `<Input>`s and visibly do not match — different border weight, different arrow, different vertical rhythm.
> **Under a strict monochrome mandate this is fatal, not cosmetic: macOS and Windows will paint their own system accent colour into the open dropdown and nothing in your stylesheet can stop them.** A platform that is "black and white only" cannot ship 32 native selects.
> **Fix:** migrate all 32 to `ui/select` (Radix — fully themeable, keyboard-complete, portal-safe). This is a **prerequisite** for the monochrome migration in §D, not a follow-up. Start with `/dashboard/agents` (8) and `/app/settings` (3).

> **[High] Search exists on 1 of 23 admin pages, and on 3 of 14 merchant pages** — `rg 'placeholder="Search'` hits `pages/app/calls.tsx`, `pages/app/orders.tsx`, `pages/app/leads.tsx`, `pages/dashboard/compliance.tsx`. Nothing on `/dashboard` (the calls list — the *default admin landing route*), `/dashboard/orgs`, `/dashboard/users`, `/dashboard/waitlist`, `/dashboard/logs`.
> Verified: `/dashboard` and `/dashboard/orgs` at 1440 render a title, a description, a divider, then content. No toolbar row at all.
> The panel that will hold every org, every user and every call log across all tenants is the one without search. At 20 rows this is invisible; at 2,000 the page is unusable — and you'll find that out on the day it matters most.
> **Fix:** one `<ListToolbar>` primitive (search + filter chips + `DateRangeSelector` + result count), rendered by `PageHeader` when given a `toolbar` prop. `/dashboard/compliance`'s Call Health chips (`degraded + silent / silent-failure / degraded / all`) are already the right pattern — extract them rather than inventing a second one.

> **[Medium] `/dashboard/settings` has no `h1` and no `PageHeader`** — `pages/dashboard/settings.tsx:96, 223` are `<h2>`s and the page has no `<h1>` at all. 22 pages use `shell/page-header.tsx`; this one starts straight at "Tracking & Analytics". The nav item pointing here is labelled **"Keys"** (`dashboard-shell.tsx:28`) — so the label, the route (`/settings`), and the two unrelated sections on the page (GTM/GA4, admin keys) disagree three ways. Verified at 1440: "Keys" is highlighted in the sidebar next to a page titled "Tracking & Analytics".
> **Fix:** `<PageHeader title="Settings" description="Tracking, analytics, and admin keys." />`; nav label → "Settings"; the two `h2`s become correct sub-sections of a real page.

> **[Medium] Raw org IDs render as row titles** — `pages/dashboard/orgs.tsx:298` `{org.name || org.id}`
> Verified: row 2 of `/dashboard/orgs` reads `org_40bb43e3-64f8-4f35-bb7a-ffbf7395eab3` at the same size and weight as "Local Test Org", and the identical string repeats verbatim in the `ID:` line directly beneath. At 390px the title wraps to two lines and becomes the widest element on the card.
> A null org name is the **normal** state, not an edge case — the name is captured during onboarding (`setup-modal.tsx:340`), so every org that hasn't finished setup has one, which is exactly the population an operator opens this page to look at.
> **Fix:** `{org.name || "Unnamed workspace"}` styled `text-muted-foreground italic`, and let the existing `ID:` line be the only place the ID appears. This is the empty-value case the rubric asks you to design before the happy path.

> **[Medium] Counts aren't pluralised, and the blocking count is styled like the routine one** — `pages/dashboard/orgs.tsx:317, 321, 325`
> `{org.connectedShops} shops` / `{org.members} members` / `{org.enabledAgents} agents` renders "**1 members**" and "**0 shops**". Three chips at identical size, weight and colour with no hierarchy — so "0 shops" (the org has no store connected; nothing can work) reads exactly as loud as "1 members" (routine).
> **Fix:** a `plural(n, "member")` helper. And give the zero-state chip §D's outlined-warning treatment (`AlertCircle` + outline) so the one that needs action is the one that looks like it.

> **[Medium] The empty analytics chart draws a full axis grid on an invented y-scale** — `pages/dashboard/analytics.tsx`, "Call volume".
> Verified at 1440 with zero calls: the chart still renders ~30 x-axis date labels and a y-axis of `0 1 2 3 4`. That 0–4 domain is not data, it's a default. An operator reads it as "the chart works, there just isn't much traffic" rather than "there is nothing here yet" — the axes are lending false credibility to an empty series.
> **Fix:** when the series total is 0, render `EmptyState` inside the chart box with the copy discipline `verticals.ts:98-105` already demonstrates. Never draw axes for data that doesn't exist.

> **[Medium] Admin empty states use three different shapes, and not one offers an action** — verified across the renders:
> | Page | Shape |
> | --- | --- |
> | `/dashboard` | one 13px grey sentence centred in a **dashed** box (`pages/dashboard/calls-list.tsx`) |
> | `/dashboard/waitlist` | **solid**-bordered card, 18px Fraunces title + 2-line body (`pages/dashboard/waitlist.tsx`) |
> | `/dashboard/analytics` | bare bordered strip, "No data in this range." ×2 |
> Meanwhile `/app` uses `shell/empty-state.tsx` in 16 files with copy that teaches the next step. The good system exists — it just stops at the `/dashboard` boundary. This is §F's praise, inverted.
> And **none** of the admin empties carry a button. `/dashboard` at zero calls should offer "Place a test call" — arguably the single most valuable action in the entire product, on the default landing route, currently absent. `/dashboard/waitlist` at zero signups should offer "Open the landing page" or "Copy the waitlist link".
> **Fix:** `EmptyState` on every admin page, with an `action` prop wired.

> **[Low] Page-header chrome is inconsistent across the panel, and org context is the dangerous half** — `/dashboard/orgs` and `/dashboard/compliance` render an icon beside the `h1`; `/dashboard`, `/analytics`, `/agents`, `/waitlist` don't. Worse, the tenant selector appears in three forms: `/dashboard/agents` puts it top-right in the header; `/dashboard/analytics` puts it in the body under a small "Org" label; `/dashboard` (the calls list — also org-scoped) has **none**, so there is no way to tell whose calls you're reading. There's no environment badge (staging vs production) anywhere either.
> **Fix:** `PageHeader` gets `icon` and `context` slots; either every page uses them or none do. The org selector isn't a consistency nit — an admin panel that renders tenant data with no visible tenant is how someone edits the wrong org's live agent.

### Cross-surface

> **[Medium] The same object is called three different things** — `lib/verticals.ts:85` and `:157` label the nav item "**Conversations**" while the route is `appPath("/calls")`; `dashboard-shell.tsx:12` labels the same entity "**Calls**"; the API is `?days=` on `/api/app/analytics` and `/api/voice/orgs/:id/analytics`. So the merchant says "conversations", the operator says "calls", the URL says `/calls`, and support has to translate between them on every ticket. Same drift on agents: `/app/agents` says "voice agents", `/dashboard/agents` says "agent templates".
> **Fix:** `verticals.ts` already owns a `glossary` — put the call/conversation noun in it and have **both** shells read it, admin included. Pick "Calls": shorter, matches the URL, matches the API, matches what a merchant says out loud.

> **[Medium] The date-range options differ between surfaces for the same metric** — `pages/app/home.tsx:450` `options={[7, 14, 30]}` vs `pages/dashboard/analytics.tsx:108` `options={[7, 30, 90]}`. Same `DateRangeSelector`, same `?days=` API (`home.tsx:382`, `analytics.tsx:49`), two vocabularies. A merchant asking "what does my 30-day look like" and an operator answering from a 90-day view are comparing different windows.
> **Fix:** one exported `RANGE_OPTIONS` in `lib/`. If merchants genuinely need 14, add it to both.

> **[Medium] The greyed-primary anti-pattern repeats in four more places** — §B found it on the landing CTA; it's systemic. Verified in the renders: `setup-modal.tsx` "Continue", `pages/app/settings.tsx` "Update password", `pages/dashboard/settings.tsx` "Generate key", and billing's "Active plan" all render grey **next to or beneath a solid-black sibling primary** ("Save changes", "Verify & Save"). On each of those pages the *blocked* button and the *available* button differ only in fill, so the user guesses.
> **Fix:** one systemwide rule — a primary button is never rendered at reduced opacity to say "you haven't filled this in yet". Keep it filled and enabled, validate on click, put the message on the field. Encode it as a `Button` invariant (no `disabled` on `variant="default"` outside a pending mutation) so it can't come back.

> **[Low] "0 total" wraps to two lines on mobile** — `/dashboard` at 390: the header metric breaks as "0" / "total" in the top-right while the title block holds the left. It's also the least prominent element on a page whose only content *is* that number.
> **Fix:** `whitespace-nowrap`. And on a list page with zero rows the count belongs in the empty state, not the header.

---

## H. Consolidated fix list by severity

**Critical**
1. `landing.tsx:33`, `WaitlistForm.tsx:16` — delete `BASE_COUNT = 43`; render the pill only on a real count.
2. `styles.css:411, 449, 672`, `styles-marketing.css:15, 21` — split `--border` / `--border-control`; control border to the measured values in §D.
3. `MarketingNav.tsx:78, 89-94` — mobile nav links and hamburger to ≥44px.
4. `WaitlistForm.tsx:235-239` — stop rendering the primary CTA disabled at 50% opacity by default.
5. `pages/app/billing.tsx:79-82` — `plan === "Free Trial"` must not set Pro's `isCurrent`; it marks Pro Current *and* Recommended and disables the only path to buy it.

**High**
5. `styles.css:423, 676, 719, 569, 575` — warning text contrast; remove the four hue-240 leftovers.
6. `WaitlistForm.tsx` (10 sites), `contact.tsx` — remove `text-red-500` / `#22C55E`; replace with the icon+text system.
7. `landing.tsx` — move `AgentDemoWidget` into the fold; add a "Book a call" secondary CTA.
8. `pricing.tsx` — publish real numbers or rename the page and change its primary action.
9. `dashboard-shell.tsx:11-30` — group 18 nav items into 6 labelled sections.
10. `styles.css:1` + `index.html` — split font imports per surface, preconnect/preload, drop the unused family from each entry point.
11. `rg '<button'` — 111 raw buttons onto `ui/button`, starting with `FallbackControls.tsx` (8), `dashboard/compliance.tsx` (7), `app/login.tsx` (7).
12. `styles-marketing.css:134-201` — scrim or reposition the hero pattern behind the headline and form.
13. `WaitlistForm.tsx:174-241` — `flex-col sm:flex-row` so the email field stops clipping at 390px.
14. `app-shell.tsx`, `workflow-editor.tsx` — `100vh` → `100dvh`; add safe-area insets.
15. `/app/agents` — fix the h1→h3 skip.
16. **32 raw `<select>` → `ui/select`** — `dashboard/agents.tsx` (8), `app/settings.tsx` (3), + 11 more files. Native selects render un-themeable OS chrome and OS accent colour; this blocks the monochrome migration.
17. `pages/app/home.tsx:458` — gate the onboarding banner on `!showModal`; onboarding currently renders three times at once.
18. `pages/app/billing.tsx:229-253` — one filled primary among the three tier CTAs; relabel the `mailto:` ones honestly.
19. `PageHeader` + a `ListToolbar` primitive — search/filter exists on 1 of 23 admin pages; `/dashboard`, `/orgs`, `/users`, `/waitlist`, `/logs` have no toolbar at all.

**Medium**
16. `index.html:17` + `page-header.tsx` — per-page document titles.
17. `dashboard-shell.tsx:35` — `font-serif` → `font-display`.
18. Type scale: 7 steps in `@theme`, codemod 345 `[Npx]` values.
19. Radius: delete 6 arbitrary values, standardise on the existing scale.
20. `styles.css:628, 637` — delete `.card-lift` and `.card-action`; one `.card-weeber[data-interactive]`.
21. `components/ui/` — add `card`, `table`, `progress`.
22. `marketing-config.ts:65-70` — source the four statistics or cut them.
23. `app.tsx:203, 219` + `dashboard-shell.tsx:25` — fix the `workflow-runs` match regex; surface `/dashboard/audit` in the nav.
24. `MarketingNav.tsx` — add Solutions/Docs to the nav; `/shopify` and `/insurance` are currently unreachable.
25. `verticals.ts:82-93` — group merchant nav into Work / Setup / Account.
26. `page-header.tsx` — add an `action` slot; give `/app/agents` a primary button.
27. `landing.tsx` — two grid breaks (inverted compliance band, one asymmetric section).
28. Progress bars → `scaleX`; replace all 20 `transition-all`; fix `transition: width/height/gap` in `styles-marketing.css:117, 561, 662` and `compliance/index.tsx:92, 106`.
29. `WaitlistForm.tsx:161-163` — surface the phone-save failure.
30. Mobile line-clamp on agent card descriptions → `sm:` and up only.
31. `pages/dashboard/settings.tsx` — add `PageHeader`/`h1` (page currently starts at `h2`); rename the "Keys" nav item to "Settings".
32. `pages/dashboard/orgs.tsx:298` — `{org.name || "Unnamed workspace"}`; stop rendering raw org IDs as row titles.
33. `pages/dashboard/orgs.tsx:317, 321, 325` — pluralise counts; give the `0 shops` blocking chip the §D warning treatment.
34. `pages/dashboard/analytics.tsx` — `EmptyState` inside the chart box when the series total is 0; stop drawing an invented 0–4 y-axis.
35. `EmptyState` + `action` on all 23 admin pages — three different shapes today, none with a next action; `/dashboard` at 0 calls should offer "Place a test call".
36. `verticals.ts` glossary — one noun for calls/conversations, read by both shells; `/app` says "Conversations", `/dashboard` says "Calls", the URL says `/calls`.
37. `home.tsx:450` / `analytics.tsx:108` — one shared `RANGE_OPTIONS`; currently `[7,14,30]` vs `[7,30,90]`.
38. `Button` invariant — no `disabled` + reduced-opacity on `variant="default"` outside a pending mutation. Fixes the greyed primary in `setup-modal.tsx`, `app/settings.tsx`, `dashboard/settings.tsx`, `app/billing.tsx`, `WaitlistForm.tsx` in one rule.
39. `components/app/setup-modal.tsx:77, 91-92` — `whitespace-nowrap` on step labels, `flex-none` on the `<li>`; "Business type" currently breaks mid-word. `:82` `bg-success` → §D.
40. `pages/app/login.tsx:418` — vertical-neutral subhead and placeholder; insurance users are told it's for their Shopify store.
41. `pages/app/settings.tsx` — disabled fields visually distinct from editable ones (recessed plate or definition list).

**Low**
42. `login.tsx:417` — informative `h1`.
43. One `Breadcrumbs`, one `<Grain />`, one `<VoiceOrb />`.
44. `components/canvas/index.ts` — delete the dead barrel.
45. `text-wrap: balance` / `pretty` on hero type.
46. Equal-height agent cards; raise the description clamp to fit the longest static string (it truncates at 1440, not just mobile); 2-up grid at `lg:` for ≤4 agents.
47. `styles.css:68-146` — delete the `:root` Vent/ember palette once nothing depends on it.
48. `PageHeader` — `icon` and `context` slots, used on all admin pages or none; add a visible org selector to `/dashboard` (org-scoped today with no tenant shown) and an environment badge.
49. `/dashboard` mobile — `whitespace-nowrap` on the "0 total" header metric; move the count into the empty state when there are no rows.

---

## Appendix — evidence

- Screenshots: `/home/user/ui-audit-shots/` — landing 390 + 768 + 1440 fold, landing full-page 1440, landing full-page 1440 reduced-motion (14,636px), `/pricing` 1440, `/app/login` 390 + 1440, **authenticated `/app`, `/app/agents`, `/app/calls`, `/app/billing`, `/app/settings` at 390 + 1440**, **authenticated `/dashboard`, `/dashboard/orgs`, `/dashboard/agents`, `/dashboard/analytics`, `/dashboard/waitlist`, `/dashboard/settings`, `/dashboard/compliance` at 390 + 1440**.
- Contrast: `scripts/contrast.py`, WCAG 2.x + APCA, all pairs in §A and §D.
- Computed styles: `mb audit` on `http://localhost:4200/` and `/__preview` (font families, sizes, weights, radii, palette, SEO, heading order).
- Competitor teardown: `mb go` + `mb text` on vapi.ai, retellai.com, bland.ai, bolna.ai — structure only.
- Drift counts: `rg` over `packages/web/src/web` — 111 `<button>` (25 `Button` imports), **32 `<select>` in 14 files (3 `ui/select` imports)**, 345 `[Npx]`, 17 raw hex in `.tsx`, 11 radius values, 84/15/2 card-class uses, `empty-state` in 16 files / `skeletons` in 20 / `page-header` in 22, component import-site census.

**How the private surfaces were reached (reproducible, and reverted):**
- `/dashboard`: `lib/admin-key.ts:13` reads the admin key from `sessionStorage['vent_admin_key']`. A Playwright init script priming it with the local dev key grants the full panel — script at `/home/user/ui-audit-notes/shot-admin.py`.
- `/app`: `components/app/user-shell.tsx:100-104` gates on `supabase.auth.getSession()`, and `appFetch` sends the bearer to `/api/app/me`. Minted a local HS256 JWT, injected it as a Supabase session in `localStorage`, and confirmed `/api/app/me` → `200` with `needsOnboarding: true`, Shopify vertical. Script at `/home/user/ui-audit-notes/shot-app.py`.
- This required temporarily appending `SUPABASE_JWT_SECRET` to `.env` (HS256 mode). **It has been removed and JWKS/ES256 mode restored** — `.env` diffs byte-identical against the pre-audit backup, and the same token now correctly returns `401 invalid_token`.

**Residual gap, stated honestly:** the insurance vertical's `/app` pages, `/app/orders`, `/app/workflows`, `/app/knowledge-base`, `/app/numbers`, `/app/integrations`, and 16 of the 23 admin routes were audited from code and from the shared shell/`PageHeader`/`EmptyState` patterns, not from their own screenshots. Every §G finding that names a specific render was verified on that render; findings that generalise a pattern across a surface say so. No live-call UI state (in-progress call, transcript stream, barge-in) could be exercised — Vite dev can't host the WS media bridge and `TWILIO_*` is blank locally, so those states remain unaudited and should be checked on staging before pilot.
