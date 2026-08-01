# Weeber UI Structural Fixes — task tracker

## Objective
Fix 3 classes of complaints, verified in real render:
1. "Whole page reloads" on sidebar nav → PageFallback flash on lazy chunk download.
2. Pages feel "detached / loaded like components" (esp. integrations).
3. "Indexing and overflowing" = z-index drift + overflow.

## Verification harness
- DEV-only `/__preview` (app.tsx, gated `import.meta.env.DEV`) → `pages/__preview.tsx`.
- Renders real AppShell + real /app pages with mock UserContext + isolated QueryClient (retry:false).
- Reachable at http://localhost:5173/__preview ; tmux session `web`, log /tmp/vite.log.
- MUST guard/remove before finishing (it's gated by DEV so tree-shaken from prod — acceptable, but confirm).

## Fix plan (ordered by leverage)
1. [DONE+VERIFIED] Prefetch chunk on nav-hover/focus/touch → lib/route-prefetch.ts + registerPrefetch() in app.tsx + NavLink handlers in app-shell.tsx. Verified: hovering "Phone Numbers" fetched numbers.tsx before click (perf resource entry).
2. [DONE+VERIFIED] Full-bleed <main> variant → ShellLayoutContext + useShellFullBleed() hook in app-shell.tsx; content-area becomes h-[100dvh] flex-col only when fullBleed; workflows canvas views (UserWorkflowStandardView, UserWorkflowCanvasEditor) call the hook + use h-full (was h-[calc(100vh-4rem)]). Verified probe: edge-to-edge, no doc scroll; reverts cleanly to padded on nav away.
3. [DONE-targeted] integrations troubleshooting card raw `rounded-lg border border-border` -> `card-weeber`. Broad sweep intentionally NOT done (most other raw-border divs are legit sub-panels/details, not card clones — high risk, low payoff).
4. [DONE integrations / N/A agents] integrations: raw "Loading..." box -> SkeletonCards; troubleshooting card -> card-weeber. agents "no PageHeader" = FALSE POSITIVE: UserAgentsPage is a redirect stub (only ever shows skeleton/EmptyState), real UI is UserAgentDetailPage which correctly uses a bespoke detail-view header like call-detail.tsx. Forcing PageHeader would break the detail pattern.
5. [SKIPPED — no real bug] z-index scale is already consistent (sidebar z-20, topbar z-30, headers z-10, overlays z-50). Only z-[100] uses = preview harness + marketing skip-link, both correct. Tokenizing = cosmetic churn + regression risk, zero user-visible payoff. The "indexing" complaint was a symptom of the overflow (#2) + reload-flash (#1), both now fixed.

## State — COMPLETE
- Fix #1 VERIFIED (hover fetched numbers.tsx before click).
- Fix #2 VERIFIED (full-bleed probe edge-to-edge no scroll; reverts to padded on nav away).
- Fix #4 integrations VERIFIED (renders clean).
- typecheck (tsc --noEmit) = 0 errors. lint (oxlint --deny-warnings) = 0 warnings/errors.
- NOT committed/pushed (awaiting user's clean-commit ritual). Preview harness is DEV-gated (import.meta.env.DEV) -> tree-shaken from prod build; kept as reusable UI-verification tool (user to decide keep/drop).

## Fix #3 broad sweep (card-primitive) — user-approved "B" [DONE — shipped in `c374b71`]
Status corrected 2026-08-01: the header below said `[IN PROGRESS]` long after the work shipped as
`c374b71` ("fix(ui): unify raw card clones to card-weeber primitive", 17 files). The only remaining
`rounded-lg border border-border` hit from the CONVERT list is `dashboard/compliance.tsx:203`, which
matches the documented EXCLUDE rule (`p-6 text-center text-muted-foreground` empty-state box) — i.e.
nothing left to convert. The list below is kept as the record of what was swept.
Root justification: `rounded-lg` = 8px corners + no shadow; `card-weeber` = `--radius` 12px + `var(--card)` bg + `--weeber-shadow-card`. Loading skeletons ALREADY carry shadow-weeber-card, real frames don't -> visible skeleton->loaded "pop" + tighter corners on clones. Box model (border 1px, padding) unchanged -> no reflow risk.

CONVERT -> card-weeber (solid content panels + table/list frames):
- components/shell/data-table.tsx:73 (SHARED table frame — fixes many admin tables at once)
- components/agent-test-chat.tsx:64
- dashboard/templates.tsx:174,307 ; flags.tsx:130,202 ; orgs.tsx:287
- dashboard/compliance.tsx:155,167,179,210,251,279,358
- dashboard/call-detail.tsx:143,159,186 ; calls-list.tsx:61 ; workflow-runs.tsx:72
- dashboard/billing.tsx:59 ; dnc.tsx:99 ; settings.tsx:108,138,283 ; broadcasts.tsx:109
- app/knowledge-base.tsx:228 ; app/call-detail.tsx:304

EXCLUDE (intentional, NOT card clones — documented):
- Empty/loading placeholder boxes `p-6 text-center text-muted-foreground` (templates:295, orgs:275, flags:190, compliance:139, billing:47) — subtle by design; card shadow would make big empty shadowed cards, worse.
- setup-modal.tsx:292,699 — sub-panels inside an already-elevated modal.
- VoicePicker:177 — dropdown popover (bg-popover shadow-xl).
- inputs/selects/textareas (bg-background), pills/badges (rounded-full/inline-flex), <details>, <pre>/<code>/<kbd>, muted inset sub-panels (bg-muted/*), nested rounded-md sublists (leads:434,723).
- public marketing/docs (docs.tsx, hosted-form.tsx) — separate design surface.

Verify: extend /__preview to mount representative admin pages inside AppShell (no admin ctx needed — confirmed). Browser-check corners+shadow parity vs skeletons.

## Notes
- edit tool needs replace_all bool.
- Verticals in code = shopify + insurance only.
