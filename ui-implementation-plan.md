# Weeber UI — Implementation & Test Plan

Companion to [`ui-audit.md`](./ui-audit.md). The audit says *what's wrong*; this says *in what order, who verifies it, and what "done" looks like*.

**Locked inputs (your answers, 2026-08-03):**

| Decision | Value | Consequence for this plan |
| --- | --- | --- |
| Monochrome scope | Whole platform, **except** measured hue for `/dashboard` compliance + call-outcome status | Phase B ships two systems: a chroma-0 ramp everywhere, plus a hard-scoped `.theme-weeber [data-surface="ops"]` semantic set. Needs an ADR. |
| Executor | Runable, directly in `/home/user/openvent` | Every phase ends with `typecheck` + `lint` + `test` green and a commit. No handoff friction, but also no second pair of eyes — hence Phase 0. |
| Priority driver | First pilot / design-partner onboarding | Functional blockers jump the queue over design. Phase A is not a design phase. |
| Marketing surface | **Out of scope** | Caps the achievable score at ~7.9 (see §Score trajectory). One carve-out I'm arguing for below. |
| Testing | Visual regression + axe gate + contrast gate + design guards + primitive unit tests + manual QA checklist | All six. Phase 0 builds the harness; Phase G flips it to blocking. |
| Off-limits | Nothing in progress | Full surface area available. |

---

## Three things I need to correct before you read the phases

**1. Vitest is not installed and I'm not adding it.** You asked for "Vitest unit tests for the new primitives." This repo runs `bun test --isolate src/` with a happy-dom global registered via `packages/web/bunfig.toml` → `test-setup.ts`, and `packages/web/src/web/components/ui/button.test.tsx` already proves component tests work under it. Adding Vitest means a second runner, a second config, a second CI step, and two ways to write the same test. **I'll write the primitive tests as `bun test` + `@testing-library/react`, matching `button.test.tsx`.** Same coverage, zero new tooling. Say the word if you specifically want Vitest and I'll add it, but I think that's a downgrade.

**2. "Lint rules that prevent regression" cannot be lint rules here.** Your linter is `oxlint` (`.oxlintrc.json`), which has no custom-rule plugin API you can write JS rules against. So "no raw hex / no arbitrary `[Npx]` / no raw `<button>` / no raw `<select>`" ships as **`scripts/design-guard.ts`** — a Bun script that greps the tree, counts violations against a committed budget file, and fails when the count goes *up*. That's actually better than a lint rule for this job: 345 arbitrary px values can't be fixed in one commit, so a binary pass/fail rule would have to be disabled on day one. A ratchet can't be.

**3. You selected both "all the CI gates" and "manual QA checklist only — no CI work."** I'm reading that as *both artifacts*, not as a contradiction: build the CI gates, **and** produce a human checklist for the things CI genuinely can't judge (does the empty state tell me what to do next, does the monochrome hierarchy still read at a glance, does the stepper feel like one product). CI catches regression; the checklist catches taste. If you meant "skip CI," Phase 0 shrinks by ~60% and Phase G loses its teeth — tell me now, because Phase 0 is the first thing I'd build.

---

## The one marketing carve-out I'm pushing back on

You scoped marketing out. I'd honour that for every layout, type, and palette finding — the hero scrim, the ragged form, the ten identical sections, the blue accent. All of it can wait.

**Except `BASE_COUNT = 43`** (`packages/web/src/web/pages/landing.tsx:33`, `components/marketing/WaitlistForm.tsx:16`). That is not a design finding. Your public site currently claims *"43 businesses already on the waitlist"* regardless of the real row count, and tells a genuine signup *"You're in — #43 in line"* (`WaitlistForm.tsx:110, 263`). You are about to put this URL in front of design partners, a JetBrains application, an AWS application, and grant reviewers, under a registered company (ADLOOM X MEDIA SOLUTIONS PVT LTD). One person checking that number against reality costs you more than every other finding in the audit combined.

It is a two-line diff and a conditional render. **I want it in Phase A.** It changes no layout, no token, no component — it is strictly "stop asserting a number that isn't true." If you still say no, I'll drop it and note it as a knowingly-accepted risk in the plan, but I'm not going to pretend it's a styling preference.

---

## Sequencing logic (why this order and not the audit's severity order)

The audit lists findings by severity. Executing in that order would be wrong, for three reasons:

1. **Guardrails before changes.** A monochrome token migration touches ~40 pages through a stylesheet. Without visual-regression baselines captured *at the current state*, there is no way to distinguish "the border is now visible" from "I accidentally broke the sidebar on mobile." Baselines must exist before Phase B, so they're Phase 0.
2. **Native `<select>` blocks monochrome.** 32 raw `<select>` elements in 14 files paint the *operating system's* accent colour into their open dropdown. No amount of `chroma: 0` in your stylesheet overrides that. So the select migration is a **prerequisite** for declaring monochrome done, not a follow-up — it lands inside Phase B, not with the other component work in C.
3. **Primitives before density.** "Add a search/filter toolbar to 23 admin pages" is 23 bespoke toolbars if `ListToolbar` doesn't exist yet, and one prop if it does. Phase C creates the primitives Phase E consumes.

```
Phase 0  Guardrails ─────────────┐  (must precede B)
Phase A  Pilot blockers ─────────┤  (independent — can run parallel to 0)
Phase B  Tokens + monochrome ────┤  (needs 0)
Phase C  Primitives ─────────────┤  (needs B for variants)
Phase D  IA / navigation ────────┤  (independent of B/C)
Phase E  Density + states ───────┤  (needs C)
Phase F  Craft / type / perf ────┤  (needs B, C)
Phase G  Harden + QA + gaps ─────┘  (needs all)
```

---

# Phase 0 — Guardrails

**Goal:** make every later phase produce a *reviewable diff* instead of a promise. Nothing user-visible changes in this phase.

### Changes

| # | Change | Where |
| --- | --- | --- |
| 0.1 | Vendor `contrast.py` into the repo | `scripts/contrast.py` (currently only at `/home/user/.skills/ui-ux-architect/scripts/contrast.py` — CI can't reach that) |
| 0.2 | `scripts/tokens.json` — the token pairs that must hold, with their floor (3:1 UI / 4.5:1 body) | new |
| 0.3 | `scripts/contrast-gate.ts` — reads `tokens.json`, shells `contrast.py`, exits non-zero on any pair under floor | new |
| 0.4 | `scripts/design-guard.ts` + `scripts/design-budget.json` — ratchet counting raw hex, `[Npx]`, raw `<button>`, raw `<select>`, `card-lift`/`card-action`, `transition-all`. Seeded with today's real numbers (17 / 345 / 111 / 32 / 15 / 20). Fails if any count rises. **Report-only** this phase | new |
| 0.5 | Visual-regression suite: `packages/web/e2e/visual.spec.ts` using `toHaveScreenshot()` at 390 / 768 / 1440, light + dark | new |
| 0.6 | Auth fixtures for the private surfaces: `e2e/fixtures/admin.ts` primes `sessionStorage['vent_admin_key']` (`lib/admin-key.ts:13`); `e2e/fixtures/app.ts` injects a Supabase session into `localStorage` | new — ports `/home/user/ui-audit-notes/shot-admin.py` + `shot-app.py` to TS |
| 0.7 | `@axe-core/playwright` → `e2e/a11y.spec.ts`, every route, **report-only** (writes a violation count artifact) | new dep |
| 0.8 | CI: add `design-guard`, `contrast`, `a11y`, `visual` jobs to `.github/workflows/ci.yml`; add all four to the `ci-success` `needs:` array | `.github/workflows/ci.yml` |
| 0.9 | Capture and commit baseline screenshots at current state | `e2e/visual.spec.ts-snapshots/` |

### Result to look for
- `bun run design:guard` prints a table of current violation counts and exits 0.
- `bun run contrast:gate` exits **non-zero today** — it should report the known `--border` 1.37:1 and 1.57:1 failures. If it exits 0 on day one, the gate is broken, not the tokens.
- CI on a no-op PR: all jobs green, `visual` reports 0 diffs, `a11y` reports a non-zero baseline count.
- Every subsequent phase's PR shows a visual diff image per changed surface.

### Verification
`bun run lint && cd packages/web && bun run typecheck && bun run test && bun run test:e2e`

### Exit gate
A deliberately-broken probe commit (change one padding value) makes `visual` go red, and reverting makes it green. **If the harness can't catch a 4px change, it won't catch a token migration — do not proceed to B until this is demonstrated.**

### Risks / honest blockers
- **`/app` visual regression needs a JWT, and that means a CI secret.** The existing `playwright.config.ts` is deliberately secret-free and runs against `vite preview` with no backend — that's why it can't go false-red. Injecting an HS256 session breaks that property. **Two options, your call:** (a) add `SUPABASE_JWT_SECRET` as a GitHub Actions secret and accept that the `/app` visual job is env-dependent; (b) keep CI secret-free and give `/app` a route-level mock provider (the `/__preview` harness at `pages/__preview.tsx` already proves the pattern) so screenshots render deterministically with no auth at all. **I recommend (b)** — it's more work up front and strictly more reliable after. `/dashboard` needs neither; the admin key is a client-side `sessionStorage` value.
- Screenshot flake from web fonts and `data-reveal` IntersectionObserver animations. Mitigation: `--reduced-motion` forced in the visual project, fonts self-hosted or `waitForFunction(() => document.fonts.ready)`, and `maxDiffPixelRatio` set deliberately rather than left at 0.
- Baselines are Linux/Chromium-rendered. They will not match a macOS run. This is a CI-only artifact; document it.

**Size:** ~1.5–2 days. This is the phase most likely to get cut for feeling like overhead. It's also the reason Phases B–F won't need re-doing.

---

# Phase A — Pilot blockers (functional, not design)

**Goal:** nothing in a design partner's first 30 minutes is broken or lying. Zero token changes, zero layout changes — this phase is safe to ship the day it's written.

### Changes

| Sev | Change | Where |
| --- | --- | --- |
| **Critical** | Free-Trial merchants are told **Pro is their current plan**, and the button that would sell it to them is `disabled`. `plan === "Free Trial"` must not set Pro's `isCurrent`. This is the only conversion path in the product and it is closed | `pages/app/billing.tsx:79-82` |
| **Critical** | Delete `BASE_COUNT = 43`; render the waitlist pill only on a real count ≥ a floor you'd defend out loud, and derive the queue position from the real row | `pages/landing.tsx:33`, `components/marketing/WaitlistForm.tsx:16, 110, 263` — *the carve-out; drop if you veto* |
| **High** | Onboarding renders **three times at once** (modal + home banner + empty state). Gate the banner on `!showModal` | `pages/app/home.tsx:458, 470-488` |
| **High** | Login hardcodes *"Voice agents for your Shopify store"* — but vertical is chosen *after* signup, and insurance exists. An insurance design partner is told they're in the wrong product on screen one | `pages/app/login.tsx:418` |
| **High** | `Button` invariant: no `disabled` + reduced-opacity on `variant="default"` outside a pending mutation. Enforce in `button.tsx` (dev-time warn) and fix the 5 call sites | `components/ui/button.tsx`; `setup-modal.tsx`, `app/settings.tsx`, `dashboard/settings.tsx`, `app/billing.tsx`, `WaitlistForm.tsx:235-239` |
| **High** | Billing has **zero filled primary buttons** across three tiers. One filled primary; relabel the `mailto:` CTAs honestly | `pages/app/billing.tsx:229-253` |
| **Medium** | `"Busines/s type"` breaks mid-word in the setup stepper | `components/app/setup-modal.tsx:77, 91-92` |
| **Medium** | Raw org IDs render as row titles with no empty-name fallback; `"1 members"` unpluralised | `pages/dashboard/orgs.tsx:298, 317-325` |
| **Medium** | One shared `RANGE_OPTIONS` — `[7,14,30]` on `/app` vs `[7,30,90]` on admin | `pages/app/home.tsx:450`, `pages/dashboard/analytics.tsx:108` |
| **Medium** | One noun for calls. `/app` says "Conversations", `/dashboard` says "Calls", the URL says `/calls`. Put it in the vertical glossary, read by both shells | `lib/verticals.ts` |

### Result to look for
- A Free-Trial merchant sees Pro as **purchasable**, with exactly one filled primary on the billing page.
- Onboarding appears **once**.
- An insurance-vertical signup never reads the word "Shopify" before choosing a vertical.
- No greyed-out primary button anywhere on first paint.
- The public waitlist number equals `SELECT count(*)` or isn't shown.

### Verification
- `bun test` — new unit tests: `billing-plan-state.test.ts` (trial → Pro is purchasable), `verticals.test.ts` extended for the glossary, `setup-modal` label no-wrap.
- Manual: walk signup → vertical choice → onboarding → billing as both a Shopify and an insurance user, at 390 and 1440.
- Visual regression will show intended diffs on `/app/billing`, `/app/home`, `/app/login` — **review and accept them explicitly**, don't blanket `--update-snapshots`.

### Exit gate
The full design-partner path (signup → vertical → onboarding → first agent → billing) runs end to end with no dead control, no wrong-vertical copy, and no unpurchasable plan.

### Risk
`billing.tsx` plan logic may be load-bearing elsewhere — grep every `isCurrent` consumer before touching it. Everything else here is local and low-risk.

**Size:** ~1 day. **Score: 4.6 → ~4.9** (Hierarchy 5→6, States 6→7).

---

# Phase B — Token foundation + monochrome migration

**Goal:** one token system, chroma exactly 0, every pair measured. This is the phase that fixes the single widest bug in the product — `--input: var(--border)` at **1.37:1 light / 1.57:1 dark** means *every text field, select, and textarea on both product surfaces currently has a functionally invisible boundary.*

### Changes (strict order — each step depends on the last)

| # | Change | Where |
| --- | --- | --- |
| B1 | **Split the border token.** `--border` (decorative, no floor) vs `--border-control` (inputs, bordered buttons, ≥3:1). Biggest a11y win in the codebase, one token, ~40 pages | `styles.css:411, 449, 672` |
| B2 | Install the measured chroma-0 ramp (`--n-000` … `--n-900`, light + dark) from `ui-audit.md` §D. Every value already contrast-verified | `styles.css` `.theme-weeber` / `.theme-weeber.dark` |
| B3 | Delete the four cool-hue-240 leftovers colliding with the warm surfaces | `styles.css:569, 575, 676, 719` |
| B4 | Delete the `:root` / `.dark` Vent "paper/ink/ember" palette; promote `.theme-weeber` to `:root` | `styles.css:68-146` |
| B5 | **Status without hue** — 4 non-hue channels (fill weight, border presence, icon glyph, text label), never fewer than 3. Ranked by fill darkness = ranked by urgency. All four states measured 5.66:1 → 17.09:1 | new `components/ui/status-badge.tsx` |
| B6 | **The scoped hue exception you chose.** Semantic colour survives *only* inside `/dashboard` compliance + call-outcome tables, behind `[data-surface="ops"]`, at re-measured values (current dark error is 4.26:1 — failing). Never on `/app`, never on marketing | `styles.css` + `pages/dashboard/compliance.tsx`, `calls-list.tsx`, `dnc.tsx` |
| B7 | Remove `text-red-500`, `border-red-400`, `#22C55E` (16 uses), `bg-success` and the other 17 raw hex in TSX | `WaitlistForm.tsx` (10 sites), `contact.tsx`, `setup-modal.tsx:82` |
| B8 | **Migrate 32 native `<select>` → `ui/select`** in 14 files (`dashboard/agents.tsx` ×8, `app/settings.tsx` ×3, +11 files). **Hard prerequisite:** a native select paints the OS accent colour into its open dropdown; ship monochrome with these and macOS puts blue in your product | 14 files |
| B9 | **ADR-070** — "Monochrome platform, with one scoped ops-semantics exception." Records the exception's boundary so this doesn't drift back into a half-migration | `docs/decisions/adr-070-*.md` + README row |

### Result to look for
- Every input on `/app` and `/dashboard` has a **visible** boundary in light *and* dark.
- `rg 'oklch\([^)]*\s0\.0[0-9]+\s' packages/web/src/web/styles.css` returns **nothing** outside the `[data-surface="ops"]` block — no residual chroma, no "brownish."
- Sidebar no longer reads warm/beige against near-white content (your original complaint).
- Open a `<select>` on macOS/Windows: dropdown is greyscale.
- Status is still scannable with hue removed — because fill weight, icon, and label all carry it.
- `bun run contrast:gate` **exits 0** — the first time in this repo's history.

### Verification
- **Contrast gate is the primary verifier.** Every pair in `tokens.json` at or above floor, light and dark. Any hand-picked replacement value gets measured — my own first attempts at both borders (`0.72` light, `0.40` dark) measured 2.34:1 and 2.18:1. **Removing hue makes borders harder, not easier:** you lose chroma as a differentiation channel and lightness has to carry all of it.
- **Visual regression across all baselines, light + dark.** This is the phase the Phase 0 harness exists for. Expect diffs on nearly every screenshot; review each one.
- Greyscale-simulation pass on the ops exception — confirm severity still ranks correctly for a deuteranopic user.
- `bun test` — `theme.test.ts` extended: no token in the light or dark ramp has non-zero chroma outside the ops scope.

### Exit gate
`contrast:gate` green + every visual diff individually reviewed and accepted + ADR-070 merged. **The ops exception must be scoped in code, not by convention** — if it can leak to `/app` via a class, it will.

### Risks
- **Highest-blast-radius phase in the plan.** One stylesheet, ~40 pages. Do B1 as its own commit and ship it before touching B2 — it's independently valuable and independently revertable.
- `styles-marketing.css` is `@import`ed at `styles.css:775`, so it ships to *every* surface. Its tokens are scoped under `.marketing` so product rendering is unaffected — but do **not** "tidy" that file in this phase. Marketing is out of scope; touching it puts marketing screenshots in your diff and makes B unreviewable.
- Deleting the `:root` Vent palette (B4) will break anything that reads `--paper`/`--ink`/`--ember` outside `.theme-weeber`. Grep first; if marketing depends on any of them, B4 waits until marketing is in scope. **Do not force it.**

**Size:** ~2.5–3 days (B8 alone is ~1 day). **Score: ~4.9 → ~5.9** (A11y 4→7, DS 4→6).

---

# Phase C — Primitives

**Goal:** stop hand-building the same four things. Every recurring element exists once, with `cva` variants, consuming Phase B tokens. Phase E is cheap only if this phase is done properly.

### Changes

| # | Change | Where |
| --- | --- | --- |
| C1 | `components/ui/card.tsx` — replaces 84 `.card-weeber` uses, 76 inline `rounded+border+bg` clones, 15 `.card-lift`, 2 `.card-action`. Variants: `default`/`interactive`/`recessed`/`inverted` | new; delete `styles.css:628, 637` |
| C2 | `components/ui/table.tsx` — `/dashboard` is 23 routes of data with no table primitive | new |
| C3 | `components/ui/list-toolbar.tsx` — search + filter chips + date range. **Search exists on 1 of 23 admin pages** | new |
| C4 | `EmptyState` gains a required `action` slot. Three different admin empty-state shapes today, **none with a next action** | `components/*/empty-state.tsx` |
| C5 | `PageHeader` gains `action`, `icon`, `context` slots — used on all admin pages or none | `components/*/page-header.tsx` |
| C6 | `components/ui/progress.tsx` — `scaleX`, not animated `width` | new |
| C7 | **111 raw `<button>` → `ui/button`**, starting `FallbackControls.tsx` (8), `dashboard/compliance.tsx` (7), `app/login.tsx` (7) | ~40 files |
| C8 | Delete dead code: `components/canvas/index.ts` barrel; dedupe `Breadcrumbs`, `<Grain />`, `<VoiceOrb />` (each defined more than once) | various |
| C9 | Decide `tooltip.tsx` / `command.tsx` / `checkbox.tsx` — **1 import site each**. `command.tsx` is 182 lines for one consumer. Adopt properly (command palette is a real admin win at 23 routes) or delete | `components/ui/` |

### Result to look for
- `rg -c 'rounded-.*border.*bg-' packages/web/src/web --glob '*.tsx'` drops from ~76 toward 0.
- `design-guard` raw-`<button>` count drops 111 → <10 (justified exceptions only).
- A new admin page is *composable*: `PageHeader` + `ListToolbar` + `Table` + `EmptyState`, no bespoke chrome.
- `ui/` has no component with fewer than 2 import sites.

### Verification
- **`bun test` unit tests per primitive** (the ones you asked for, in `bun test` not Vitest): `card.test.tsx` (variant → class, `asChild` polymorphism), `table.test.tsx` (semantic `<caption>`/`<th scope>`, keyboard nav), `list-toolbar.test.tsx` (debounced search fires, filter state is URL-serialisable), `empty-state.test.tsx` (**fails to compile without an `action`** — that's the point).
- axe report count must **drop**, not hold — C7 fixes a large class of missing accessible names.
- Visual diffs should be near-zero on well-migrated pages. **A large unexpected diff means the primitive doesn't match what it replaced** — fix the primitive, don't accept the snapshot.

### Exit gate
Zero raw `<button>`/`<select>` outside `ui/`, `card`+`table`+`list-toolbar`+`progress` exist with passing tests, and every `ui/` component has ≥2 consumers or a written reason.

### Risk
C7 is 111 mechanical edits across ~40 files — the classic place to silently drop an `onClick`, a `type="submit"`, or an `aria-label`. Do it in batches of ~10 files, one commit each, with the visual + a11y suites run per batch. Resist the single mega-commit.

**Size:** ~3–4 days. **Score: ~5.9 → ~6.5** (DS 6→8, Visual Craft 5→6).

---

# Phase D — Information architecture & navigation

**Goal:** a merchant and an ops user can both find things. Independent of B and C — can run in parallel if you want two tracks.

### Changes

| # | Change | Where |
| --- | --- | --- |
| D1 | Add `group` to `NavItem`; render labelled sections with dividers | `components/shell/app-shell.tsx:16-19` |
| D2 | **Admin: 18 flat items → 6 labelled groups.** ~600px of undifferentiated list today, with the three analytics pages scattered at positions 3, 12, 13 | `components/dashboard/dashboard-shell.tsx:11-29` |
| D3 | **Merchant: 11 flat items → Work / Setup / Account** | `lib/verticals.ts:81-95` (shopify), `:153-166` (insurance) |
| D4 | Fix the mislabelled nav entry — `"Keys"` points at `/dashboard/settings` | `dashboard-shell.tsx:28` |
| D5 | Surface the orphan routes: `/dashboard/audit` and `/dashboard/workflow-runs` exist with no nav entry; fix the `workflow-runs` active-match regex | `app.tsx:203, 219`, `dashboard-shell.tsx:25` |
| D6 | Visible **org/tenant selector** and **environment badge** on `/dashboard`. The panel is org-scoped today and shows the tenant nowhere — a genuine ops-safety issue once real pilot data exists | `dashboard-shell.tsx` |
| D7 | Per-page document titles (single title for 38 routes today) | `index.html:17` + `page-header.tsx` |
| D8 | Add `h1`/`PageHeader` to `/dashboard/settings` (page starts at `h2`); fix the `h1→h3` skip on `/app/agents` | `pages/dashboard/settings.tsx`, `pages/app/agents.tsx` |
| D9 | `dashboard-shell.tsx:35` — `font-serif` → `font-display` | `dashboard-shell.tsx:35` |
| D10 | Disambiguate the bottom-left "Lock" action (unlabelled, unclear) | `dashboard-shell.tsx` |

### Result to look for
- Neither sidebar has more than ~5 items in one visual group.
- Every route in `app.tsx` is either reachable from nav or documented as intentionally hidden — **assert this in a test**, don't check it by hand.
- Browser history is readable: distinct titles per page.
- An ops user always knows which org and which environment they're looking at.

### Verification
- **`bun test`: `nav-coverage.test.ts`** — parse the route table, parse both nav configs, fail on any route with no nav entry and no explicit allow-list exception. This permanently kills the orphan-route class of bug.
- `bun test`: heading-order assertion per shell (exactly one `h1`, no level skips).
- axe: `page-has-heading-one` and `heading-order` violations → 0.
- Visual: sidebar diffs on every screenshot — expected and desirable.

### Exit gate
`nav-coverage.test.ts` green, axe heading violations at 0, both sidebars grouped.

### Risk
Nav grouping changes the active-state matching logic — the `workflow-runs` regex bug is already evidence of that fragility. Test the active state for all 38 routes, not just the ones you clicked.

**Size:** ~1.5 days. **Score: ~6.5 → ~6.9** (Hierarchy 6→8).

---

# Phase E — Density, states, edge cases

**Goal:** `/dashboard` adopts the system `/app` already has. Per the audit: *"`/app`'s architecture is the best part of this codebase and `/dashboard` is the surface nobody has designed."* This phase closes that gap. Cheap only because Phase C built the parts.

### Changes

| # | Change | Where |
| --- | --- | --- |
| E1 | `ListToolbar` on every list page: `/dashboard`, `/orgs`, `/users`, `/waitlist`, `/logs`, `/calls-list`, `/dnc`, `/templates`, `/broadcasts`, … | ~12 admin pages |
| E2 | `EmptyState` + `action` on all 23 admin pages. `/dashboard` at 0 calls currently shows one grey sentence in a dashed box with **no button** — it should offer *"Place a test call."* | 23 pages |
| E3 | `EmptyState` **inside** the chart box when the series total is 0 — analytics currently draws an invented 0–4 y-axis on no data. Fabricated axis on an empty dataset | `pages/dashboard/analytics.tsx` |
| E4 | Give `0 shops` the §D warning treatment — it's a *blocking* state rendered as one of three identical grey chips | `pages/dashboard/orgs.tsx:317-325` |
| E5 | Metric hierarchy: `/dashboard`'s only metric ("0 total") is its least prominent element and wraps on mobile | `pages/dashboard/calls-list.tsx` |
| E6 | Disabled fields visually distinct from editable ones — recessed plate or definition list | `pages/app/settings.tsx` |
| E7 | Surface the silent phone-save failure | `components/marketing/WaitlistForm.tsx:161-163` |
| E8 | Fill the vertical void: `/dashboard` content occupies the top ~150px of a 694px viewport; `/app/login`'s card is 365px wide in a 1440 viewport with ~140px dead space above and below | `dashboard-shell.tsx`, `pages/app/login.tsx` |
| E9 | Honour the subtitle promise — `/dashboard/orgs` says it shows "store connection status" and doesn't | `pages/dashboard/orgs.tsx` |

### Result to look for
- **Every empty state on every surface answers "what do I do now?" with a button.** This is the single highest-value change for pilot onboarding — a design partner's first login *is* an empty state, on every page.
- Every list of >10 rows is searchable and filterable.
- No chart draws axes for data that doesn't exist.
- Blocking states look different from informational ones — without hue, via Phase B's fill/icon/label system.

### Verification
- Manual QA against seeded-empty and seeded-full DB states. **This is the phase the human checklist matters most** — "does this empty state tell me what to do next" is not machine-checkable.
- `bun test`: every admin page's zero-state render includes at least one `<button>`/`<a>` — enforceable, and enforce it.
- Visual regression at both data volumes: empty and ~50 rows.
- Re-run with the local test data in `/home/user/openvent-dev-notes.md` (2 orgs, 2 members, 1 lead) — near-empty by nature, which is exactly the pilot condition.

### Exit gate
All 23 admin pages: `PageHeader` + toolbar (if a list) + `EmptyState` with an action. Zero bespoke page chrome.

### Risk
Volume, not difficulty — 23 pages of repetitive work is where attention lapses. Batch by 5, run the suites per batch.

**Size:** ~3 days. **Score: ~6.9 → ~7.2** (States 7→9).

---

# Phase F — Craft, type scale, responsive, performance

**Goal:** clear out the mechanical debt that makes the product read hand-assembled. Mostly codemods. Boring, high-volume, verifiable.

### Changes

| # | Change | Where |
| --- | --- | --- |
| F1 | **Codemod 345 arbitrary `[Npx]` values onto a 7-step scale** (top offenders: `[10px]` ×70, `[11px]` ×43, `[15px]` ×33, `[14px]` ×29, `[1100px]` ×20) | `@theme` in `styles.css` + ~all TSX |
| F2 | Radius: delete 6 arbitrary values, standardise on the existing scale (11 distinct radii today) | various |
| F3 | **Font split.** 4 families in one render-blocking `@import` chain at `styles.css:1`, no preconnect, no preload, and `index.html` has no font `<link>` at all. Bricolage Grotesque is imported in both stylesheets and referenced **once**. Split per surface; `font-sans` ×8 and `font-serif` ×1 suggest two of the four families are near-dead on product surfaces | `styles.css:1`, `packages/web/index.html` |
| F4 | Replace all 20 `transition-all`; fix `transition: width/height/gap` in `styles-marketing.css:117, 561, 662` and `compliance/index.tsx:92, 106`. Progress bars → `scaleX` via C6 | various |
| F5 | `100vh` → `100dvh` + safe-area insets — mobile chrome currently clips the shell | `app-shell.tsx`, `workflow-editor.tsx` |
| F6 | Mobile nav is desktop links in a drawer; touch targets ~20px against a 44px floor | `dashboard-shell.tsx`, `app-shell.tsx` |
| F7 | Agent-card layout: `items-stretch` + `flex-col` + `mt-auto` on the meta row; raise the description clamp (it truncates at 1440 too, not just mobile); 2-up grid at `lg:` for ≤4 agents | `pages/app/agents.tsx` |
| F8 | Clamp descriptions only at `sm:` and up — mobile has vertical room and is truncating for no reason | `pages/app/agents.tsx` |

### Result to look for
- `design-guard` arbitrary-px count 345 → <20.
- Distinct font sizes per page ≤7, radii ≤5.
- Lighthouse/`mb audit`: no render-blocking font `@import`; FCP improves measurably. **Record the before number or the claim is meaningless.**
- No layout-thrashing transitions (`transition-all`, animated `width`/`height`/`gap`).
- Product shell renders correctly on a 390×844 viewport with browser chrome visible.
- All touch targets ≥44px.

### Verification
- `design-guard` is the primary verifier for F1/F2/F4 — this is the phase that ratchets the budget down hard.
- Visual regression is **critical here**: a px codemod is exactly the change that shifts something 1px everywhere and 40px in one place. Every diff reviewed.
- `mb audit` before/after on computed styles: font-family count, font-size count, radius count.
- axe: `target-size` violations → 0.
- Real-device check at 390 — CI's headless viewport does not have browser chrome, so `dvh` correctness is **not** provable in CI. Manual, and say so.

### Exit gate
`design-guard` budget at target, zero visual regressions unexplained, `target-size` clean, and a recorded FCP delta.

### Risk
F1 is the largest mechanical diff in the plan. Do it per-directory (`components/ui` → `components/app` → `components/dashboard` → `pages/app` → `pages/dashboard`), never repo-wide in one pass. `[1100px]` ×20 is a *container width*, not a spacing value — it needs a `--container-*` token, not a spacing-scale entry. Don't let a regex flatten that distinction.

**Size:** ~2.5 days. **Score: ~7.2 → ~7.8** (Visual Craft 6→7, Responsive 4→7, Perf 5→8).

---

# Phase G — Harden, verify, close the gaps

**Goal:** make the guardrails blocking, then honestly state what remains unverified.

### Changes

| # | Change | Where |
| --- | --- | --- |
| G1 | Flip `design-guard` from report-only to **blocking**, with the ratcheted budget committed | `scripts/design-budget.json` |
| G2 | Flip axe from report-only to **blocking** on `serious` + `critical` | `e2e/a11y.spec.ts` |
| G3 | Re-baseline all visual snapshots at the final state; commit | `e2e/visual.spec.ts-snapshots/` |
| G4 | Write `docs/reference/ui-qa-checklist.md` — the human pass, organised by surface, with the per-phase "result to look for" items that CI cannot judge | new |
| G5 | Update `ui-audit.md` with a post-implementation score column and mark each of the 49 findings fixed / deferred / won't-fix | `ui-audit.md` |
| G6 | ADR-071 if the Phase B ops exception moved at all in practice | `docs/decisions/` |
| G7 | **Close the audit's residual gaps** — screenshot and review the surfaces the audit explicitly could not reach | see below |

### The residual gaps, restated plainly
The audit was honest that these were reviewed from code and shared patterns, not from their own renders:
- The **insurance vertical's** `/app` pages (only Shopify was rendered).
- `/app/orders`, `/app/workflows`, `/app/knowledge-base`, `/app/numbers`, `/app/integrations`.
- **16 of 23** admin routes.
- **All live-call UI states** — in-progress call, streaming transcript, barge-in. Vite dev cannot host the WS media bridge and `TWILIO_*` is blank locally, so these are **unverifiable in this environment at all**. They must be checked on staging before a pilot call is placed. This is the largest remaining unknown in the plan and no amount of local work closes it.

### Result to look for
- CI fails a PR that introduces a raw hex, an arbitrary px, a raw `<button>`, a contrast regression, or a serious axe violation. **Prove it with a deliberate probe PR, don't assume.**
- Every finding in `ui-audit.md` has a resolution status.
- The insurance vertical looks as finished as Shopify.
- A written staging test plan exists for the live-call states.

### Exit gate
A probe PR containing one raw hex and one 3:1-failing token is **rejected by CI**. That's the whole point of Phase 0, demonstrated.

**Size:** ~1.5 days + staging time you'll need to schedule separately. **Score: ~7.8 → ~7.9** (A11y 7→8).

---

## Score trajectory

| After | Hier 20% | DS 20% | A11y 20% | Craft 15% | Resp 10% | States 10% | Perf 5% | **Weighted** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Today | 5 | 4 | 4 | 5 | 4 | 6 | 5 | **4.6** |
| Phase A | 6 | 4 | 4 | 5 | 4 | 7 | 5 | **4.9** |
| Phase B | 6 | 6 | 7 | 5 | 4 | 7 | 5 | **5.9** |
| Phase C | 6 | 8 | 7 | 6 | 4 | 7 | 5 | **6.5** |
| Phase D | 8 | 8 | 7 | 6 | 4 | 7 | 5 | **6.9** |
| Phase E | 8 | 8 | 7 | 6 | 4 | 9 | 5 | **7.2** |
| Phase F | 8 | 8 | 7 | 7 | 7 | 9 | 8 | **7.8** |
| Phase G | 8 | 8 | 8 | 7 | 7 | 9 | 8 | **7.9** |

**The ceiling is ~7.9, and marketing is why.** Skipping the marketing surface leaves in place: 6 measured contrast failures (`#7A7A82` at 4.15:1, `--m-input-border` at 1.98:1, `--m-accent-blue` at 2.75:1), ~20px mobile nav touch targets, the hero pattern running through the headline with no scrim, the email field clipping to `"you@yourbran"` at 390px, ten sections of one layout, and four unsourced statistics. Those cap Accessibility at 8, Visual Craft at 7, and Responsive at 7 no matter how good the product surfaces get. **Getting past 8.0 requires a Phase H on marketing** — worth scheduling before any grant or investor review, and it's roughly 2 days once Phase B's ramp exists to build on.

**Total: ~16–19 working days** across 8 phases, sequential. Phase A alone is ~1 day and removes every functional blocker in a design partner's first session — if you only have a week, do 0 + A + B1 and stop.

---

## Open questions

1. **The `BASE_COUNT = 43` carve-out** — in or out? (§"The one marketing carve-out.") I want it in Phase A.
2. **`/app` visual-regression auth** — CI secret (option a) or a route-level mock provider (option b)? I recommend (b): slower to build, strictly more reliable, keeps CI secret-free.
3. **Vitest or `bun test`** for the primitive tests? I'm defaulting to `bun test` to match `button.test.tsx`.
4. **`command.tsx`** (182 lines, 1 import site) — adopt as a real admin command palette across 23 routes, or delete? Same question for `tooltip.tsx` and `checkbox.tsx`.
5. **Commit granularity** — one commit per numbered change, one per phase, or a branch per phase with a PR? Phase 0's harness only earns its keep with reviewable increments; I'd default to a branch per phase, commits per numbered change.
6. **Staging access for the live-call states** (Phase G7) — is there a staging environment with real `TWILIO_*` I can point a browser at? If not, that gap stays open regardless of how the rest goes.
