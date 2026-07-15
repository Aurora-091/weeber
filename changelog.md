# Developer Changelog (Internal Changelog)

This document tracks system changes, database schemas, API parameters, and architectural details implemented during the backend workstream updates.

---

## 2026-07-15 — Made every existing migration idempotent (safe fresh-bootstrap + disaster-recovery replay)

Follow-up to the outage above — asked to make the whole migration set robust the same way, not just
patch the one thing that broke. Verified first (reading drizzle-orm's actual `PgDialect.migrate`
source, `pg-core/dialect.js`) that this is completely safe to do retroactively: it only compares each
migration's own folder timestamp against the single most-recently-applied migration's timestamp —
it never re-hashes or re-diffs an already-applied migration's file content. Editing old, already-
applied migration files has zero effect on whether they get re-run against an already-migrated
database (confirmed this is genuinely true before touching anything, not assumed).

**Found two more real, pre-existing bugs while validating**, both independent of anything from this
session's earlier work, by installing a throwaway local Postgres and running the full `0000`→`0024`
chain from a genuinely empty database (something nobody had apparently done in a long time — every
real deploy had migrations trickle in against an already-partially-migrated DB, so these never
surfaced):
- `0010_performance_indexes.sql` and `0011_grey_scarlet_spider.sql` both create the exact same two
  indexes (`calls_org_id_idx`, `scheduled_calls_org_id_idx`) — a truly fresh `bun run db:migrate` has
  been unable to complete since `0011` was added.
- `0014_jittery_menace.sql`'s `recovered_amount` column type change (`text` -> `numeric(12,2)`) has
  no `USING` clause — Postgres has no implicit text-to-numeric cast, so this could never have
  succeeded against a fresh DB with any real (even empty-string) data in the column. It only ever
  "worked" in production because that column had already drifted to numeric via an earlier
  `drizzle-kit push` before this file's ALTER ran, making it a harmless numeric-to-numeric precision
  change instead of the real cast it was written as.

**Fix, swept mechanically across all 24 existing migration files** (`0000` through `0024`):
`CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX` -> `IF NOT EXISTS`; `DROP TABLE`/`DROP INDEX`/
`ALTER TABLE ... DROP CONSTRAINT` -> `IF EXISTS`; `ALTER TABLE ... ADD COLUMN` -> `IF NOT EXISTS`
(Postgres has supported this directly since 9.6). `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT
EXISTS` syntax in Postgres at all, so those are wrapped in `DO $$ BEGIN ... EXCEPTION WHEN ... THEN
null; END $$;` blocks instead — which took three iterations to get the exception-class list right,
each found by actually reproducing the failure locally rather than guessing: `duplicate_object`
(42710, the common named-constraint case), `invalid_table_definition` (42P16, re-adding a PRIMARY KEY
specifically raises "multiple primary keys... not allowed" under this different class even with a
different constraint name), and `duplicate_table` (42P07, UNIQUE constraints create a backing index
under the hood and hit "relation already exists" on that index's name). `0014`'s `recovered_amount`
conversion got a bespoke fix instead of the generic sweep — an explicit `USING (NULLIF(...,
'')::numeric(12,2))` for the real text->numeric case, wrapped in a `DO $$ ... IF (SELECT data_type
FROM information_schema.columns ...) = 'text' THEN ... END IF; END $$;` guard so re-running it once
the column's already numeric doesn't itself fail differently (NULLIF's `''` comparand can't cast to
numeric once the column stops being text).

**Validated for real, not assumed** — a disposable local Postgres 17, three full scenarios:
1. Fresh empty database, full `0000`→`0025` chain: now succeeds end-to-end (previously failed at
   `0010`/`0011`'s duplicate index, and would have failed again at `0014` if that had been reached).
2. Disaster-recovery replay — wiped `drizzle."__drizzle_migrations"` entirely and re-ran the full
   chain against the already-fully-migrated database from scenario 1 (simulates exactly the kind of
   state today's `org_integrations` drift put us in): succeeds end-to-end, only informational
   `NOTICE`s, zero errors.
3. Normal re-deploy (tracking table intact): still a fast no-op skip via the timestamp check, as
   before — confirmed this change doesn't add overhead to the common case.
- `drizzle-kit generate` against the fully-migrated local DB reports zero schema drift against
  `schema.ts` afterward.

Also spot-checked and confirmed a real, separate tooling gotcha hit twice while writing this: this
session's file-editing tool silently collapses a literal `$` (Postgres's dollar-quote delimiter) down
to a single `# Developer Changelog (Internal Changelog)

This document tracks system changes, database schemas, API parameters, and architectural details implemented during the backend workstream updates.

---

 when written directly — worked around by generating it via string concatenation in the
sweep script, and via `sed` for the one hand-edited file (`0014`). Flagging here in case it bites a
future migration edit the same way.

Not touched (already covered by other verification): the production database itself doesn't need any
of this replayed — every one of these 24 migrations is already applied there and will keep being
skipped by the timestamp check regardless of file content. This work is entirely about making the
*next* fresh-bootstrap or disaster-recovery scenario (a new environment, a restored backup, a wiped
tracking table) actually work, since today's incident showed that path was silently broken.

Verified after all of the above: typecheck (api) green, full suite 289/289 pass, oxlint 0 warnings/
errors, `drizzle-kit generate` reports no schema drift.

## 2026-07-15 — Production outage: DB migrations were never applied on deploy (agents/calls pages 500ing)

**Symptom**: `/api/app/analytics` and `/api/app/agent-configs` both 500ing in production — reported
as "agents not loading." Server logs showed `Failed query` on plain selects against `calls` and
`org_agent_configs`.

**Root cause**: `railway.json`'s `startCommand` (`bun run start:railway` -> `cd packages/api && bun run
src/server.ts`) never ran `drizzle-kit migrate` — deploying new code with `schema.ts` changes does
**not** apply the matching SQL migrations to the live Postgres. Confirmed the production DB's
`drizzle."__drizzle_migrations"` table was stuck at migration `0020_tearful_union_jack` — four
real migrations behind `schema.ts` (`0021_add_call_sentiment`, `0022_add_knowledge_base`,
`0023_add_org_phone_numbers`, `0024_add_turn_latency`), meaning every one of those features had been
silently broken in production since the day it was deployed, not just today.

**Fix**:
- Ran `bun run db:migrate` against production — applied all four pending migrations, verified
  `calls.sentiment`, `org_agent_configs.phone_number_id`, `turn_latency`, `org_phone_numbers`, and
  `knowledge_documents` all now exist, and re-ran the exact failing queries from the log directly —
  both succeed.
- `package.json`'s `start:railway` now runs `cd packages/api && bunx drizzle-kit migrate && bun run
  src/server.ts` — every deploy self-heals any pending migration before the server starts. Confirmed
  idempotent (re-running against an already-migrated DB is a no-op, safe to run on every boot).

**Second, related finding while fixing this**: discovered a **second, separate migration system**
(`supabase/migrations/*.sql`, run via Supabase's own CLI/tooling against the same physical Postgres
instance) that the API's actual code doesn't know about — `drizzle-kit` and Supabase's migration
history are two independent, unaware-of-each-other tracking mechanisms against the same database. A
new `org_integrations` table (per-org CRM/Calendar credentials — see next entry) was created through
the Supabase path with a hand-written SQL file, while `schema.ts` was updated to match — but no
corresponding file existed under `packages/api/drizzle/`, so `drizzle-kit generate` treated it as a
brand-new, ungenerated table and would have tried to `CREATE TABLE` it again (no `IF NOT EXISTS`) the
next time `db:migrate` ran — which, after the `start:railway` fix above, is now *every deploy*. Would
have caused a second, self-inflicted outage on the very next push.
- Reconciled: generated the missing drizzle migration (`0025_add_org_integrations.sql`), added
  `IF NOT EXISTS`/`CREATE UNIQUE INDEX IF NOT EXISTS` guards (matching how the Supabase-side version
  was already written), and ran it against production — confirmed idempotent no-op (table/index
  already existed), and drizzle's own migration tracking is now caught up too. `drizzle-kit generate`
  reports zero drift after this.
- **Not resolved, flagging for a real decision**: the two parallel migration systems still exist and
  can drift again the same way. Recommend picking one canonical path (this codebase's actual runtime
  reads `schema.ts`/`packages/api/drizzle/` via `drizzle-orm/postgres-js` — `supabase/migrations/`
  appears to be a legacy/parallel path from earlier Supabase-CLI-based work) before the next schema
  change that touches both.

**Also restored** `packages/api/scripts/latency-benchmark.ts` (accidentally deleted twice this week,
breaking typecheck both times via `src/latency-benchmark.test.ts`'s dangling import) — see §2b in
`plan.md`/this session's earlier commits for what the tool does.

**Also fixed**: `hubspot.test.ts`'s `syncToHubspot` test was asserting a stale call-count (2) from
before `syncToHubspot` gained real per-org credential support (`apiKeyOverride` param, feeding the new
`org_integrations` table) and a search-before-create flow (3 calls: search miss -> create -> log note,
or 2 calls when an existing contact is found by phone search — added a second test case covering
that path, which didn't exist before).

Verified after all of the above: typecheck (api+web) green, full suite 289+9+34 = 332 pass / 0 fail
across all three packages, oxlint 0 warnings/errors, vite build green, `drizzle-kit generate` reports
no schema drift.

## 2026-07-13 — Misc-3: revenue-attribution stat cards on the merchant Analytics page

Picked as the lowest-risk, highest-reward item on the Misc list (`WEEBER-PLAN.md`) — turned out to be
even cheaper than scoped: `computeKpis` (`packages/api/src/voice/org-queries.ts`) already computed
`kpis.recovery` (recovered revenue/orders/rate) and `kpis.codConfirmation` (confirm rate) as part of
`/api/app/analytics` — the frontend simply never rendered it. Zero backend or schema changes.

- `pages/app/analytics.tsx`: new stat-card row — "Revenue recovered" (currency-formatted via
  `Intl.NumberFormat`, keyed off `org.currency`, defaults to INR), "Carts recovered", "Cart recovery
  rate", "COD confirm rate" — each only rendered when that vertical actually has activity (same
  pattern the rest of the page already uses for its other sections).
- Verified: typecheck (3 packages), 9/9 web tests, oxlint 0/0, vite build all clean.

## 2026-07-13 — Number management gap confirmed and fully spec'd (C2b) — docs only, not built

Traced exactly what exists today for phone numbers, prompted by a direct question about how a
merchant would assign/reassign/decommission a number to a specific agent — there was no answer in the
code, and now there's a concrete spec instead of "not verified."

- **Confirmed**: `orgs.outboundNumber` is a single text column — one number per org, period.
  `voice/twilio-provisioning.ts`'s `buyNumberForOrg` searches with `limit: 1` and auto-buys the first
  match, no picker. No release/decommission function exists anywhere. `org_agent_configs` has no
  number field, so every agent on an org shares the one number. No dedicated Numbers page — the only UI
  is a single-number connect form inside `pages/app/integrations.tsx`. Plivo/Exotel provisioning is
  BYO-only (no platform-purchase flow like Twilio's).
- **Spec'd for when it's built** (`WEEBER-PLAN.md`, Phase C, workstream C2b): a new `org_phone_numbers`
  table (replaces the single column, supports N numbers per org from mixed providers), a
  `phone_number_id` FK on `org_agent_configs` (per-agent assignment, falls back to the org's primary
  number if unset), a new `/app/numbers` page scoped strictly to the caller's own org (real
  candidate-picker for buying, a release action), and a dropdown on the agent config page wired to that
  same per-org number list. Also flagged in `architecture/data-model.md`'s "notable absences."
- Not built this session — documented per explicit direction to stop for the day after this.

## 2026-07-13 — WEEBER-PLAN.md sharpened with two pre-existing research reports (A1, D1-D4)

Folded findings from `voice-ai-orchestration.report` and `weeber-stack-decision.report` (both
2026-07-12, predate this session's work) into the roadmap written earlier today. Docs only.

- **A1 gained a real sub-item, A1b**: a VAD/endpointing audit against the actual competitive bar
  (4-state VAD machine, adaptive noise filtering, rule+ML+regex endpointing, speculative/"greedy"
  inference, sub-100ms interruption handling) — the report is explicit this is the real gap between
  "production-grade" and "demo," not vendor choice. A1 was previously checked off; it still is for the
  pipeline itself, but A1b makes clear that isn't the same as matching Retell/Vapi's orchestration
  quality.
- **D1 (TTS in-house)** got a concrete first target: Kokoro v1.0 (82M params, Apache 2.0, CPU-viable),
  Orpheus as the voice-cloning upgrade path — replacing a vague "evaluate later."
- **D2 (fine-tuned LLM/S2S)** got a harder "don't yet": small-model function-calling reliability is a
  documented regression for tool-heavy flows, not just a cost/effort tradeoff. STT self-hosting has its
  own separate "not yet" (Groq Whisper-v3 at $0.04/hr is already cheap without owning infra).
- **D3 (prepaid wallet)** now cites a sourced, sharper COGS figure to price against: openvent's own
  runtime blends to ~$0.048/min, cheaper than the round "~$0.06/min" used elsewhere.
- **New D4 — GPU credits, concrete path**: join NVIDIA Inception now (free, no gate, unlocks Nebius AI
  Lift's $150K+$10K neocloud credits later); AWS Activate's $1-5K self-serve tier is reachable now; the
  larger Google/AWS Portfolio tiers gate behind funding/accelerator credentials not yet held.
- **One stale claim resolved**: `weeber-stack-decision.report` said no per-tenant Twilio isolation
  existed — confirmed stale, A2's `twilio-provisioning.ts` work closed that gap after the report was
  written.

## 2026-07-13 — New architecture/ folder, WEEBER-PLAN.md rewritten as the phase roadmap, doc cleanup

Restructuring pass, no code behavior changes (one comment-only edit in `voice/routes.ts`, verified with
full CI — typecheck/lint/test all green).

- **New `architecture/` folder** (repo root, alongside `audit/`): `README.md` (moved + rewritten from
  `docs/architecture.md`, which described a pre-Postgres/pre-package-split layout — corrected against
  the current `packages/api`+`packages/web` split), `voice-orchestration.md` (mermaid sequence diagram
  of the call pipeline + telephony abstraction + STT/TTS provider status), `api-flow.md` (mermaid:
  Shopify webhook → scheduled call → compliance gate → outbound dial, plus the COD-confirmation
  exhaustion flow), `user-flow.md` (mermaid: onboarding, both `/dashboard` and `/app` route trees, the
  2026-07-13 agent-console full-window redesign), `data-model.md` (mermaid ER diagram of all 27 tables,
  with a call-out section for notable absences — no KB table, no per-org DNC, no multi-seat).
- **`WEEBER-PLAN.md` rewritten entirely** (same filename, per explicit direction) — was a Shopify-only
  workstream list, is now the full Phase A/B/C/D roadmap from the competitive-teardown digest, checked
  line-by-line against real code with file/function references and `[x]`/`[ ]` checkboxes. The old
  workstreams (F, G, I, P, Q, R, S) are folded in under the phase they fit, nothing dropped. New finding
  while writing it: the cart-recovery/insurance persona prompts (`docs/agent-prompts/01`, `04`)
  instruct the agent to answer from a "knowledge base" that doesn't exist in the schema/backend —
  flagged inline in `01-cart-recovery-agent.md` as aspirational, not live.
- **`docs/archive/` created** — moved 4 stale docs there (not deleted): `CLAUDE-BUILD-BRIEF.md`,
  `USER-APP-PAGE-MAP.md` (both pre-build specs for dashboards that are now live), `project_analysis.md`
  (describes a pre-Postgres-migration state), `docs/component-documentation-template.md` (unused
  generic boilerplate). `docs/insurance-vertical-meeting-prep.md` was reviewed and **kept** — it's a
  real, current doc for an active upcoming client meeting, not stale.
- **Cross-references updated**: `CLAUDE.md`'s doc map and repo-structure tree, `docs/dashboard.md`,
  `docs/getting-started.md`, `UI-DESIGN-BRIEF.md`, and one code comment in `voice/routes.ts` that
  pointed at the now-moved `docs/architecture.md`.

## 2026-07-13 — Doc sweep: WEEBER-PLAN/CLAUDE-BUILD-BRIEF/USER-APP-PAGE-MAP synced to actual code

Full cross-check of pending-work docs against current code (backend/infra/integration scope, separate
from the UI-focused doc sweep earlier the same day). Findings:

- **`WEEBER-PLAN.md`**: workstreams J (checkout-token cancellation), K (order-value attribution), L
  (org-scoped GDPR erasure), M (`gdpr-redact-notify` wiring), N (per-org caller ID), O (Twilio
  sub-accounts), and E (Vercel deploy) were all listed as open/remaining but are actually **done** and
  verified in code (tests exist for J/K/L; `twilio-provisioning.ts` is real, not a stub; three Vercel
  projects are live per the Merchant→User rename entries). Marked done in the workstream table and the
  "Merged backlog detail" section. P (per-org DNC), Q (RBAC/multi-seat), R (Nango/per-org CRM), S
  (entry-condition "trigger split") confirmed still genuinely open — no code found for any of them.
  G (real Shopify checkout E2E test) and I (India compliance confirmation) flagged as needing a real
  answer outside a sandbox, not more code.
- **New gap found**: `VerticalDefinition.dashboard.metrics/cards` (`verticals.ts`) is defined but never
  read by `pages/app/home.tsx` — dead config. This directly contradicts a claim in
  `USER-APP-PAGE-MAP.md`'s 2026-07-12 update note ("Home page's content is config-driven per vertical")
  — corrected there too.
- **`USER-APP-PAGE-MAP.md`**: fixed a stale table row still saying `/app/*` was "not built yet" despite
  the doc's own 2026-07-12 update note confirming it shipped; added the dashboard-config correction
  above.
- **`CLAUDE-BUILD-BRIEF.md`**: added a status banner — this was the pre-build spec for both dashboards,
  both are now live; kept as historical design record, not a current TODO.

No code changed in this pass — docs only.

## 2026-07-13 — UI/UX audit #04 fixes: theme portal-scoping, agent full-window console, Workflow Canvas P1 bugs, Dependabot cleared

Full details in `audit/2026-07-13-audit-04-uiux.md` (the audit itself) and ADR-054/ADR-055
(`DECISIONS.md`). Four separate pushes this session, all CI-green (typecheck, tests, lint, build,
migration-drift, and GitHub's own CI/CodeQL checks on `origin/main`):

- **`8ae86e8`** — fixed a CI break: `verticals.test.ts`'s hardcoded nav-array-length assertions
  (7/6) weren't updated when the Workflows nav item shipped (now 8/7).
- **`1c1240d`** — Workflow Canvas P1 fixes: save buttons (both `/app/workflows` and
  `/dashboard/workflows/:id`) permanently showed "Saved" after the first save even with later
  unsaved edits (`save.isSuccess` never reset — added real `dirty`-state tracking instead); a
  failed `/api/app/workflow-configs` fetch rendered as "no workflows"/"workflow not found" instead
  of a real error on both the merchant list and detail pages. Also: agent console full-window
  redesign (ADR-055) — new `AppShell` `fullBleed` prop, always-visible agent-switcher pill,
  `/app/agents` and `/dashboard/agents` both redesigned, `collapsible` added to `DashboardShell`
  for parity with `UserShell`. Preview drawer (voice test call) re-verified working after the
  layout change — wiring untouched, backend suites 19/19.
- **`15ed444`** — theme portal-scoping fix (ADR-054): Dialog/Sheet/DropdownMenu/Tooltip/Select now
  portal into the themed shell via a new `PortalContainerContext`
  (`lib/portal-container.ts`) instead of defaulting to `document.body` and silently falling back
  to the wrong theme. Also fixed a dead CSS selector (`[data-radix-dialog-content]`, an attribute
  Radix never emits) found alongside it.
- **`c17600b`** — cleared both open Dependabot alerts: `uuid` 8.3.2→11.1.1 (transitive via
  `exceljs`, real vulnerable version was in `bun.lock` too, not just the stray lockfile) and
  `esbuild` unified to 0.25.12 tree-wide via root `package.json` `overrides` (Bun 1.3.14 supports
  npm-style overrides). Removed the stray root `package-lock.json` — unused by any script/CI
  (repo runs on `bun@1.3.14`), already drifting out of sync with `bun.lock`, and real `npm install`
  errored trying to reconcile it against Bun's `node_modules` layout even with
  `--package-lock-only`, confirming it wasn't something this repo's toolchain could safely
  maintain. Verified via GitHub API after push: 0 open Dependabot alerts.

Also updated `docs/UI-UX-AUDIT-CONTEXT.md` (checklist section now reflects current status instead
of the original bug-report snapshot) and `docs/workflow-canvas-architecture.md` (added a status
note — the canvas it specs is now built, doc kept as historical design record).

## 2026-07-13 — Merchant→User infra rename completed; compat shim removed

Closes out the "infra rename still pending" item from the entry below (the Vercel API could do
it after all — no dashboard needed): Vercel project `weeber-merchant` renamed to **`weeber-app`**
(pairs with `weeber-admin` the way `app.weeber.ai` pairs with `admin.weeber.ai`),
`VITE_APP_SURFACE` flipped `merchant`→`user` (production + preview), redeployed and verified live
on `app.weeber.ai`. Vercel keeps the old default domain on rename, so `weeber-merchant.vercel.app`
was swapped for `weeber-app.vercel.app` manually. With the flip confirmed, the `merchant`-alias
shim in `app.tsx`/`lib/route-base.ts` is deleted — `VITE_APP_SURFACE=merchant` is no longer
accepted anywhere.

## 2026-07-13 — "Merchant" renamed to "User" across code, docs, and (pending) infra

Terminology fix, not a data-model or behavior change: Shopify store owners are only
one of Weeber's client types — clinics, and eventually insurance/hospital clients, are
not "merchants" in any meaningful sense, so hardcoding that word into the tenant-facing
app's internal naming was Shopify-flavored bias baked into the platform's own vocabulary.
The DB schema was already vertical-neutral (`orgs`, `org_members`, `vertical` column —
no "merchant" anywhere), and the admin dashboard's own Users page already called these
people "Users" — so "User" was the only rename target that didn't introduce a new,
colliding vocabulary (ruled out "Customer": `verticals.ts`'s `glossary.customer` already
means the org's own end-customers/patients being called, a different concept entirely).

- **Renamed throughout** (~55 files, code identifiers + comments + living docs):
  `MerchantShell`→`UserShell`, `Merchant*Page` components→`User*Page`,
  `requireMerchantSession`→`requireUserSession`, `requireMerchantOrg`→`requireUserOrg`,
  `merchantApp`→`userApp`, `merchantRole`/`merchantOrgId`/`merchantUserId`/`merchantEmail`
  context vars→`userRole`/`userOrgId`/`userUserId`/`userEmail`, `useMerchant`→`useUser`,
  `MerchantMe`→`UserMe`, `merchantHeaders`→`userHeaders`. Files renamed:
  `lib/merchant-session.ts`→`lib/user-session.ts`,
  `components/app/merchant-shell.tsx`→`components/app/user-shell.tsx`,
  `MERCHANT-APP-PAGE-MAP.md`→`USER-APP-PAGE-MAP.md`. Living reference docs (`CLAUDE.md`,
  `WEEBER-PLAN.md`, `CLAUDE-BUILD-BRIEF.md`, `UI-DESIGN-BRIEF.md`,
  `docs/contract.md`/`dashboard.md`/`india-telephony.md`/`workflow-canvas-architecture.md`)
  updated to match.
- **Deliberately left untouched**: `changelog.md`/`DECISIONS.md`/`AGENT-CONSOLE-UI-PLAN.md`/
  `project_analysis.md`/`audit/*.md` (historical records — rewriting past entries to use
  today's vocabulary would misrepresent what was actually decided/found at the time), the
  three Shopify-vertical agent prompt docs (`docs/agent-prompts/*.md` — `{{merchant_name}}`
  is correct there, it's Shopify's own vocabulary for a store owner, not our platform's),
  and two narrative copy references to real Shopify merchants (`landing.tsx`'s TCPA-fine
  story, `email-templates.ts`'s "Shopify merchants" waitlist copy).
- **Backward-compat shim** (`app.tsx`, `lib/route-base.ts`): `VITE_APP_SURFACE=merchant` is
  still accepted as an alias for `"user"` at the exact point the env var is read, since the
  live `weeber-merchant` Vercel project was created with that value before this rename —
  this avoids a coordination-timing outage between this code push landing and the Vercel
  project's env var actually being updated. Verified: `VITE_APP_SURFACE=user` and
  `VITE_APP_SURFACE=merchant` builds produce byte-identical-size bundles.
- **Infra rename still pending** (manual, Vercel dashboard — not exposed via the available
  API tooling): rename the `weeber-merchant` project (suggest `weeber-user` or `weeber-app`)
  and flip its `VITE_APP_SURFACE` env var from `merchant` to `user`. The backward-compat
  shim above means there's no urgency/outage risk either way — remove the shim once
  confirmed flipped.
- Verified: api typecheck clean + 191/191 tests, web typecheck clean + 8/8 tests, lint
  0/0, all four surface builds (`public`/`admin`/`user`/legacy `merchant`) succeed.

## 2026-07-13 — Hosted Supabase auth config synced (site_url, redirect allowlist, recovery template)

`supabase config push` against the hosted project (`wtqohdcghmxuujqyhlkz`) revealed the hosted auth
config had never been synced with the repo's `config.toml`:

- **`site_url` was still `http://localhost:5173`** (repo said `https://app.weeber.ai` since ADR-043's
  session, but only locally). Consequence: the hosted **recovery email was still the old link-based
  template**, and its `{{ .ConfirmationURL }}` — with no `redirectTo` passed by `login.tsx` — pointed
  at the site_url, i.e. password-reset emails linked to `localhost:5173`. Hosted password reset was
  broken end-to-end until this sync; it now sends the committed OTP-code-only template, which the
  login page's forgot-password flow verifies inline (`verifyOtp` type `recovery`).
- **Redirect allowlist cleaned:** stale `openvent-api*.vercel.app` / `openvent-*-rex80s-projects
  .vercel.app` preview entries (pre-split single-project era) removed. New list is exactly the three
  legitimate surfaces — `https://app.weeber.ai`, `https://admin.weeber.ai`, `http://localhost:5173`,
  each as bare origin + `/**` glob (`config.toml` updated to match; bare origin and glob are both
  needed because `/**` doesn't match the bare root). No live flow depends on the allowlist (all auth
  emails are OTP-code-only) — this is hygiene for the `/auth/callback` / `/auth/reset-password`
  fallback routes and any future OAuth.
- Also fixed a stale `config.toml` comment still claiming recovery keeps its link.
- Sync workflow note: `supabase config push --project-ref wtqohdcghmxuujqyhlkz` from repo root is the
  way to apply future `config.toml`/email-template changes to the hosted project (needs
  `supabase login` once per machine).

## 2026-07-13 — Waitlist email links: referral links now use PUBLIC_WEB_URL, not the API origin

- **Bug:** `app/waitlist.ts` built both email links off `PUBLIC_APP_URL`, which by repo convention is
  the API's own Railway origin (Twilio webhook construction/signature verification in
  `voice/twilio-client.ts`/`middleware/twilio-signature.ts` require that meaning). On the split deploy
  the API origin serves no frontend, so waitlist confirmation/referral-notification emails carried
  referral links like `https://api-production-….up.railway.app?ref=…` → 404. Unsubscribe links were
  unaffected (they target a real `/api/public/waitlist/unsubscribe` route on the API origin).
- **Fix:** referral links now use new env var `PUBLIC_WEB_URL` (fallback `https://www.weeber.ai` — the
  landing page is what consumes `?ref=`); unsubscribe links stay on `PUBLIC_APP_URL`. `PUBLIC_WEB_URL`
  was already set on the Railway service but referenced nowhere in code until now; documented in
  `.env.example`.

## 2026-07-12 — Agent Preview drawer, Phase 2: real full-duplex in-browser voice test call

Ships the "biggest lift" piece from `AGENT-CONSOLE-UI-PLAN.md` (§3, Phase 2) on both `/app/agents`
(merchant) and `/dashboard/agents` (admin) — a real mic-in/agent-voice-out test call inside the
Preview drawer's Voice tab, not a simulation. Backend-plus-frontend unit, not a UI-only change.

- **Architecture decision**: this is a *new parallel handler* (`voice/test-call-stream.ts`), **not** a
  4th telephony provider inside `createVoiceStreamHandlers`/`stream.ts`. That engine writes DB call
  rows, runs workflows/webhooks, and enforces DNC/compliance/caller-memory — all unwanted overhead
  for a config-testing sandbox. The new handler reuses only the pipeline primitives every real call
  already uses: `connectStt`, `connectTts`, `runVoiceAgentTurn`, `runVoiceAgentGreeting` — so the test
  call is genuinely the real STT→LLM→TTS pipeline, just without a phone number or persisted call
  record. Max call duration capped at 5 minutes server-side.
- **Wire format**: 8kHz mu-law, matching what `connectStt`/`connectTts` already assume natively — zero
  backend STT/TTS changes needed. Client protocol (documented in `test-call-stream.ts`'s header
  comment): client→server `{"type":"media","audio":"<base64 mulaw>"}` / `{"type":"stop"}`;
  server→client `{"type":"ready"}`, `{"type":"audio",...}`, `{"type":"transcript","role":...}`,
  `{"type":"clear"}` (barge-in signal), `{"type":"ended","reason":...}`, `{"type":"error",...}`.
- **Auth — two-step token handshake**: a browser `WebSocket` can't send custom headers, so a raw
  session/API-key can't ride the WS URL safely. New short-lived, single-use tokens
  (`voice/test-call-tokens.ts`, in-memory, 2-min TTL) are issued by an HTTP POST (which *can* carry
  normal auth) and consumed once by the WS upgrade at `/api/voice/test-call?token=...`
  (`ws-route.ts`, token-gated, dual-dispatches "voice" vs "test-call" socket kinds).
  - Merchant: `POST /api/app/agent-configs/:templateKey/test-call-token` (session-authed,
    `testCallRateLimited`, optional `configOverride` validated via `AgentFrameSchema`).
  - Admin: `POST /api/voice/orgs/:orgId/agent-configs/:templateKey/test-call-token` (admin-key gated,
    `adminTestCallRateLimited`).
- **Rate limiting**: `voice/fixed-window-limiter.ts` extracted as the one shared
  `makeFixedWindowLimiter` (previously a local duplicate inside `app/routes.ts`) — same
  can't-be-unmetered principle already applied to `previewRateLimited`/`testChatRateLimited`, tighter
  window since a full test call costs more than one TTS sentence.
- **Frontend**: `lib/audio-codec.ts` (browser-safe port of the API's mulaw/pcm16 math, no `Buffer`),
  `hooks/useVoiceTestCall.ts` (mic capture, 48kHz→8kHz downsample, mulaw encode, WS send/receive,
  playback queue, barge-in on `{"type":"clear"}`, mic/agent audio-level metering for the orb).
  `PreviewDrawer.tsx`'s Voice tab now has real Start/End call buttons and a live transcript log, wired
  on both `pages/app/agents.tsx` and `pages/dashboard/agents.tsx`; the prior one-shot "Hear this
  agent" TTS button stays as a secondary quick-check below it.
- **Known limitation**: `ScriptProcessorNode` (deprecated but functional in all evergreen browsers) is
  used for mic capture — an `AudioWorklet` migration is a reasonable future cleanup, not urgent.
- Verified: api typecheck/lint clean, 191 tests pass (17 new — token issue/consume/expiry,
  stream state transitions with mocked stt/tts/agent); web typecheck/lint/build clean (no new web
  unit tests — the hook is browser-API-heavy and hard to unit test meaningfully without a real
  mic/`AudioContext`; judged low value versus the backend state-machine tests, which cover the actual
  pipeline logic).

## 2026-07-12 — Agent Preview drawer, Phase 1: backend-wired live-edit preview (text tab + orb shell)

First half of `AGENT-CONSOLE-UI-PLAN.md` — a "Preview" button (top-right on both `/app/agents` and
`/dashboard/agents`) opening a right-side drawer (`components/agent-preview/`: `PreviewButton`,
`PreviewDrawer`, `VoiceOrb`, `useAudioLevel`), shared identically on both surfaces. Not decorative:
the drawer's Text tab tests the agent's **current, unsaved, in-progress form state** — not just what's
already saved to the DB.

- **Backend**: new `buildPreviewAgentConfig(templateKey, override)` in `voice/agent.ts` builds
  systemPrompt/voice/llm/tools directly from an `AgentFrame` override instead of reading a saved
  `orgAgentConfigs` row, falling back to the template's default persona when
  `override.personaPrompt` is empty (matching what a real call would get).
- Both existing test-chat routes (`app/routes.ts` merchant, `voice/routes.ts` admin) now accept an
  optional `configOverride` in the request body, validated via the existing `AgentFrameSchema` —
  routes to `buildPreviewAgentConfig` when present, falls back to the existing `resolveAgentConfig`
  (saved row) when omitted.
- **Frontend**: `PreviewDrawer`'s Voice tab reuses the existing one-shot `/voice-preview` WAV endpoint
  (orb reacts to TTS playback level only at this stage — full mic-in duplex is Phase 2 above); Text
  tab reuses the existing `AgentTestChat` component (previously admin-only, inline on the page) now
  restyled to sit inside the drawer and — new — exposed on the merchant surface for the first time,
  sending `configOverride` from the live form state.
- Verified: typecheck x3 (api/web/compliance), 216/216 tests (api 174 incl. 7 new, web 8, compliance
  34), lint 0/0, web build clean, migration-drift clean.

## 2026-07-12 — Subdomain routing implementation

- **New file:** `src/web/lib/domains.ts` — cross-subdomain URL helpers (`wwwUrl`, `adminUrl`, `appUrl`) driven by `VITE_WWW_ORIGIN`, `VITE_ADMIN_ORIGIN`, `VITE_APP_ORIGIN`. Unset = same-origin relative paths (local dev).
- **Updated `MarketingNav`:** added "Log in" button linking to `appUrl("/app/login")`.
- **Updated `app.tsx`:** added cross-subdomain redirect fallback routes — if a user hits `/dashboard/*` on the public surface or `/app/*` on the admin surface (or vice versa), they get redirected to the correct subdomain in production.
- **Updated `.env.example`:** added `VITE_WWW_ORIGIN`, `VITE_ADMIN_ORIGIN`, `VITE_APP_ORIGIN` env vars; set `CORS_ALLOWED_ORIGINS` to the three production subdomains.
- **Updated `supabase/config.toml`:** `site_url` set to `https://app.weeber.ai`; redirect allowlist includes `app.weeber.ai`, `admin.weeber.ai`, and `localhost:5173`.
- **Deployment model:** three Vercel projects from same repo, each with its own `VITE_APP_SURFACE` value (`public`/`admin`/`merchant`) and the subdomain origins set. Railway backend's `CORS_ALLOWED_ORIGINS` must be set to all three.

## 2026-07-12 — Merchant impersonation removed entirely

Full reasoning in DECISIONS.md ADR-050. Deleted `app/impersonation.ts` + its test, the
`X-Weeber-Impersonation` auth path in `requireMerchantSession` (now Supabase-session-only), the
`/api/app/impersonation/stop`, `/api/voice/impersonation/start`, `/api/voice/impersonation/:id/stop`,
`/api/voice/impersonation/audit` routes, and the "Log in as"/"Impersonate Workspace" UI on the
Users and Orgs admin pages. `impersonation_sessions` table dropped via migration `0018` — historical
audit rows are gone, not archived (explicit user choice). `MerchantMe.impersonated` removed from the
`/api/app/me` response contract.

---

## 2026-07-12 — Audit #02 fixes: cross-provider scheduled calls, Exotel frame padding, contract sync, discount amount type

Resolves F1–F4 from `audit/2026-07-12-audit-02.md`. Full reasoning and repro traces in that report;
this entry covers what actually changed in code.

- **F1 (P0/critical)** — `workflows/scheduler.ts`'s `executeDueScheduledCalls` dialed *unconditionally
  through Twilio* for every scheduled call, regardless of `org.telephonyProvider`. `getTwilioClientForOrg`
  silently falls back to the platform Twilio client when an org has no Twilio creds, so every Shopify
  automation (cart recovery, COD confirmation, feedback) for a Plivo/Exotel BYO org was placing calls from
  the platform's Twilio number instead of the org's actual number — broken in a way invisible from a
  manual dashboard test call, since `voice/routes.ts`'s manual-call path already branched correctly.
  Fixed by extracting a single provider-routing path, `voice/place-outbound-call.ts`, used by both
  `scheduler.ts` and `voice/routes.ts` — one call-placement function, one place to get provider selection
  right. 2 new provider-routing tests.
- **F2** — Exotel outbound PCM16 media wasn't guaranteed to be a multiple of 320 bytes (Exotel's required
  frame size); `telephony-transport.ts` now pads via `padToFrameMultiple` in `buildOutboundMedia`.
- **F3** — `docs/contract.md` didn't exist in this repo at all (only in weebersh), and code comments in
  `routes.ts`/`client.ts`/`secret-auth.ts` cited a stale "v1.4" while weebersh's copy had already moved to
  1.5 (documenting the whole-number discount-percentage semantics a prior weebersh fix depended on).
  Copied weebersh's `contract.md@1.5` into `openvent/docs/`, bumped all code comment references to 1.5.
  Both repos now share one source of truth for the wire contract.
- **F4** — `recovered_amount` was `text`, not a real numeric type; changed to `numeric(12,2)`
  (`schema.ts` + migration `0014_jittery_menace.sql`; `platform_settings` CREATE also made
  `IF NOT EXISTS` in the same migration).

Verified before commit: typecheck 3/3, oxlint 0/0, tests pass (compliance 34, api 176, web 8).

## 2026-07-12 — Dynamic GTM/GA4 tracking configuration

- **New table:** `platform_settings` (key-value, admin-managed) — stores platform-level config like GTM container ID and GA4 measurement ID. Generic design for future settings without schema changes.
- **Admin endpoints:** `GET /api/voice/platform-settings` (list all), `PUT /api/voice/platform-settings/:key` (upsert with live validation against Google's endpoints before saving).
- **Public endpoint:** `GET /api/public/tracking-config` — returns GTM/GA4 IDs only, cached 5 min, no auth required.
- **Frontend:** `TrackingScripts` component dynamically injects GTM/GA4 scripts based on backend config. Mounted in app root so all pages are tracked.
- **Admin UI:** New "Tracking & Analytics" section at top of `/dashboard/settings` with validated inputs, verify-before-save, and inline success/error feedback.
- **index.html:** Removed hardcoded commented-out GTM/GA4 blocks — replaced by dynamic injection.

## 2026-07-12 — Resend transactional email module

- **New file:** `packages/api/src/app/email.ts` — thin Resend wrapper for single-send transactional emails (non-blocking, graceful no-op when `RESEND_API_KEY` unset).
- **New file:** `packages/api/src/app/email-templates.ts` — branded HTML templates (warm paper theme, Weeber logo, accent `#C4622D`, responsive).
- **Waitlist confirmation:** on new signup → "You're in — welcome to Weeber" email with mini pitch, what-to-expect bullets, referral CTA, unsubscribe link. No position number shown.
- **Referral notification:** when someone joins via a referral link → notifies the referrer.
- **Enterprise inquiry receipt:** auto-acknowledgment on `/enterprise-inquiry` submit.
- **Support ticket receipt:** auto-acknowledgment on `/support` submit.
- **Env vars:** `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (defaults to hello@weeber.ai), `PUBLIC_APP_URL`.

## 2026-07-12 — Admin SSO (Supabase email/password login)

- **New table:** `platform_admins` — email allowlist for admin dashboard access. Service-role-only RLS.
- **New middleware:** `packages/api/src/voice/middleware/admin-session.ts` — verifies Supabase JWT, checks email against `platform_admins`. Falls through to API-key auth if no Bearer token present.
- **New endpoint:** `GET /api/voice/admin-me` — returns authenticated admin's email and role.
- **Updated `requireAdminKey`:** skips if a prior middleware already authenticated (session-based auth takes priority).
- **Admin login page:** `packages/web/src/web/pages/dashboard/admin-login.tsx` — email/password form via `supabase.auth.signInWithPassword()`.
- **Updated `AdminKeyGate`:** first tries Supabase session, falls back to API key. "Use API key instead" link preserved for CI/scripts.
- **Updated `adminHeaders`:** new `adminHeadersAsync()` helper sends Bearer token when session exists.

## 2026-07-12 — Route isolation prep (VITE_APP_SURFACE)

- **New env var:** `VITE_APP_SURFACE` — `"all"` (default), `"public"`, `"admin"`, or `"merchant"`.
- **Updated `app.tsx`:** routes conditionally rendered based on surface value.
- Enables future subdomain isolation via multiple Vercel projects (one per surface, same repo, different env vars) without code changes.

---

## 2026-07-12 — Setup modal + vertical-driven dashboard, Plivo/Exotel telephony, CI hardening

Three commits (`497a880`, `0c13b23`, `969861c`) — full reasoning in `DECISIONS.md` ADR-047/048/049,
summarized here per this file's own convention (routine changes belong here, architectural reasoning
stays in DECISIONS.md).

**Onboarding/dashboard (ADR-047):** `/app` now renders `pages/app/home.tsx` (checklist card + vertical-
driven metric tiles) instead of a dedicated onboarding page. Setup moved into
`components/app/setup-modal.tsx`, opened on top of the dashboard. `pages/app/onboarding.tsx` deleted.
New `onboarding_state` table (migration `0011`) + `GET`/`PATCH /api/app/onboarding`. `VerticalDefinition`
(`lib/verticals.ts`) gained a `dashboard{ metrics, emptyState }` shape; the old "Setup" nav entry is
folded into "Home"; the Integrations nav item's label is now the vertical's own `integrationLabel`
("Shopify") instead of a hardcoded "Integrations".

**Telephony: Plivo + Exotel (ADR-048, ADR-049):** BYO credentials for both (`orgs.telephonyProvider` +
per-provider credential columns, migration `0012`) with real validate-before-store checks
(`voice/plivo-provisioning.ts`, `voice/exotel-provisioning.ts`), plus a real per-provider call transport
— not just stored credentials. `voice/telephony-transport.ts` normalizes all three providers' WS wire
formats to one shape; `voice/audio-codec.ts` gained `pcm16ToMulaw` (Exotel is raw PCM, not mu-law like
Twilio/Plivo); `stream.ts` takes an explicit `provider` param; `ws-route.ts` has one WS path per provider;
`voice/plivo-client.ts`/`voice/exotel-client.ts` place real outbound calls; `calls.provider` column added
(migration `0013`). **Not yet live-verified** — no prototype call was possible in this environment; see
ADR-049 for the specific unconfirmed assumptions (Plivo `request_uuid`↔`CallUUID`, Exotel connect-response
`sid`↔WS `start` event `call_sid`) and why the code degrades instead of breaking if either is wrong.
Corrected a stale claim in `docs/india-telephony.md`: Exotel is not SIP-trunk-only anymore (AgentStream
now has a real bidirectional WebSocket) — the doc's older "needs a LiveKit SIP bridge" framing is outdated.

**CI (no ADR — routine):** `.github/workflows/ci.yml` split into parallel `typecheck`/`test`/`build`/
`lint` jobs plus a new `migration-drift` job (fails if `drizzle-kit generate` would produce a new file —
catches an uncommitted schema change), all gated behind one `ci-success` job. Fixed two pre-existing test
fragilities exposed while landing the above: `routes.test.ts`'s `admin-auth` mock was silently bypassed by
a real `ADMIN_API_KEY` leaking in from `packages/api/.env` (bun auto-loads it) the moment routes.ts's
import graph changed at all — traced to a `bun mock.module` quirk via a zero-dependency reproduction, not
a logic bug — fixed by having the test clear the env var explicitly. `llm/index.test.ts` had the same
class of issue with `AI_GATEWAY_MODEL`; fixed by asserting against the actual resolved default
(`GROQ_MODEL` now exported from `voice/llm/index.ts`) instead of a hardcoded model-name literal.

Full verification before each commit: `packages/api` tsc + 174/174 tests, `packages/web` tsc + 8/8 tests +
production build, `packages/openvent-compliance` tsc + 34/34 tests, root `oxlint` — all clean.

---

## Completed Backend Workstreams

| Workstream | Module / Component | Focus / Goal | Core Changes & Files |
| :--- | :--- | :--- | :--- |
| **Workstream A** | Config & Seeding | Database-backed agent template config overrides & hierarchical prompt resolution | - Created `agent_templates` and `org_agent_configs` tables<br>- Idempotent catalog seeder inside `seed.ts` executing at boot<br>- Hierarchical lookup logic inside `agent.ts`<br>- Dynamic voice stream prompt loading |
| **Workstream J** | Webhook Cancellation | Cancel pending Shopify cart-recovery scheduled calls by `checkoutToken` first | - Added `checkout_token` column & index to `scheduled_calls`<br>- Populated token on webhooks and workflow retry engines<br>- Cancel by token with fallback to phone in `/orders/create` |
| **Workstream K** | Order Attribution | Matching executed recovery calls with orders within 7-day conversion window | - Populates `recovered_order_id` and `recovered_amount` on successful order conversion webhooks |
| **Workstream L & M** | Scoped GDPR Erasure | Erasure of Shopify customer data and GDPR Edge function notification | - Scoped Drizzle deletions inside `adapters.ts` (calls, transcripts, callerMemory)<br>- Protected edge function call using `resilientCall` inside `/customers/redact` |
| **Workstream N** | Per-Org Outbound Caller ID | Dynamic resolution of outbound dial-time caller ID | - Added `outbound_number` to `orgs` table<br>- Gated POST `/calls/outbound` and scheduler sweeps to resolve phone number priority |

---

## Database Schema Modifications

| Table Name | Column Name | Data Type | Modifiers / Indexing / Description |
| :--- | :--- | :--- | :--- |
| **`orgs`** | `outbound_number` | `text` | Org-specific outbound Twilio dial-time phone number |
| **`scheduled_calls`** | `checkout_token` | `text` | Shopify cart token; indexed for checkout match performance |
| **`scheduled_calls`** | `recovered_order_id` | `text` | Shopify converted order ID |
| **`scheduled_calls`** | `recovered_amount` | `text` | Converted checkout amount |
| **`agent_templates`** | *New Table* | - | Static catalog of Shopify agent prompt configurations |
| **`org_agent_configs`**| *New Table* | - | Organization specific prompt overrides matching templates |

---

## API & Parameter Updates

- **POST `/calls/outbound`**:
  - Accept optional parameter `orgId` (string) in JSON body payload.
  - Automatically sets Twilio outbound caller ID parameter to the org's configured `outboundNumber` if present, with TWILIO_PHONE_NUMBER env fallback.
- **POST `/integrations/shopify/orders/create`**:
  - Validates `checkout_token` along with `phone` to identify recovery opportunities.
- **POST `/integrations/shopify/customers/redact`**:
  - Erases all customer recordings/transcripts within the organization bounds, and fires the `gdpr-redact-notify` edge function.

---

## 2026-07-10 — Audit #01 fixes (D1, D2)

- **D1 (build-breaking, fixed):** `packages/api/src/voice/routes.test.ts` had two `noUnusedParameters` TS
  errors that left `main`'s `tsc --noEmit` failing. Fixed by prefixing the two unused mock params with `_`.
- **D2 (compliance-adjacent, fixed after explicit user confirmation):** `callerMemory` was keyed by
  `phoneNumber` only — a phone number is not a unique identity across the whole system, so a GDPR erasure
  request from one Weeber merchant could silently delete another merchant's memory of the same caller.
  - `caller_memory` table: added `org_id` column (`text`, default `""` for self-hosted/no-org usage), primary
    key changed from `(phone_number)` to `(org_id, phone_number)`. Migration: `packages/api/drizzle/0002_lame_thena.sql`.
  - `getCallerMemory` / `upsertCallerMemory` (`caller-memory.ts`) now take `orgId` as their first argument.
  - `eraseOrgDataForPhoneNumber` (`compliance/adapters.ts`) now scopes the `caller_memory` delete by
    `(orgId, phoneNumber)`, matching how it already scoped `calls`/`scheduledCalls`.
  - New regression test: `packages/api/src/voice/compliance/adapters.test.ts` asserts the delete condition
    references `org_id`, and that two orgs' erasure calls produce distinct conditions.
  - No production data existed yet (ADR-034), so this was a clean structural migration, not an additive-only
    patch — acceptable per that same precedent.

---

## 2026-07-10 — Root cause of "sorry, I didn't catch that" every turn

`AI_GATEWAY_BASE_URL` on Railway was set to `https://ai-gateway.vercel.sh/v1` — a path that doesn't exist.
The AI SDK's own default (and the correct one) is `.../v4/ai`. Every LLM turn was 404ing against
`/v1/language-model`, and `agent.ts`'s empty-completion fallback silently turned that into "sorry, I didn't
catch that" instead of surfacing a real error, which looked exactly like an STT problem from the caller's
seat. Fixed by correcting the Railway env var (no code change) and confirmed live via a real outbound test
call + DB transcript. Also added diagnostic logging (`agent.ts`, logs finishReason/usage/tool calls/history
length on any empty-turn fallback) so a repeat of this class of bug surfaces immediately next time.

## 2026-07-10 — Agent skills: hangUp, transferToHuman, silence handling, guardrails

- **New tools** (`voice/tools/`): `hangUp` (agent ends the call — actually terminates the Twilio call leg via
  the REST API, not just the WebSocket, after the closing line finishes), `transferToHuman` (redirects the
  live call to `orgs.humanTransferNumber` / `HUMAN_TRANSFER_NUMBER` env fallback via a real `<Dial>`, same
  override-then-env pattern as `outboundNumber`), `flagGuardrailEvent` (model self-reports a guardrail
  moment — topic-boundary / unauthorized-promise / prompt-injection / abuse — logged through the existing
  `toolCalls` table, so it's visible on the call-detail dashboard with zero new UI).
- **Persona hardening** (`agent.ts`): new `withCallControl()` wraps every resolved persona (org override,
  template, explicit, env map, or hardcoded default — one injection point, not duplicated per template) with
  call-control and guardrail instructions covering hangUp/transfer usage, topic boundaries, not inventing
  prices/policies, and holding the system persona against caller-supplied "ignore your instructions"-style
  attempts.
- **Heuristic prompt-injection detector** (`stream.ts`): independent, defense-in-depth phrase scan on raw
  caller transcript text (regex set for "ignore your instructions", "you are now a...", etc.) — logs a
  `guardrail-heuristic-detector` tool-call row even if the model doesn't self-report via flagGuardrailEvent.
- **Silence handling** (`stream.ts`): after each spoken turn, an 8s timer arms; if the caller stays silent,
  the agent re-prompts once ("Are you still there?"), then hangs up after a further 7s of silence. Resets on
  any real caller speech. Re-prompt/goodbye lines are canned (no LLM call) so a flaky turn can't compound a
  quiet caller into an even longer wait.
- **Voicemail detection**: outbound calls now request async AMD (`machineDetection: "DetectMessageEnd"`,
  `asyncAmd`, new `/amd-status-callback` route). If Twilio reports a machine answered, the live call is
  redirected out of the agent stream to a short `<Say>` + `<Hangup>` instead of running the agent into an
  answering machine's beep and silence.
- **Schema**: `orgs.human_transfer_number` (additive, nullable) — migration `0003_normal_wallop.sql`.
- New tests: `tools/hangUp.test.ts`, `tools/transferToHuman.test.ts`, `tools/flagGuardrailEvent.test.ts`,
  `stream.test.ts` (heuristic detector + playback-estimate helper), plus a `resolvePersona` assertion that
  call-control instructions land on every persona source.

## 2026-07-10 — Agent "frame" + merchant dashboard (config, voice preview, analytics)

Groundwork for a future "describe the agent you want" AI-builder flow: a fixed, structured config schema
("the frame") a merchant configures by hand today, and an AI prompt plugs values into later — same shape
either way, no new code paths needed when that flow exists.

- **`voice/agent-frame.ts`** — the single source of truth for the frame's shape: `AgentFrameSchema` (zod),
  `AVAILABLE_TOOL_NAMES`, `RECOMMENDED_LLM_MODELS`, `TONE_STYLES`, `STRICTNESS_LEVELS`. Dashboard form, API
  validation, and any future AI builder all import from here — not redefined per call site.
- **Schema**: `org_agent_configs` extended additively — `name`, `greeting_line`, `closing_line`,
  `tone_style`, `voice_provider`, `voice_id`, `language`, `llm_provider`, `llm_model`, `tools_enabled`
  (jsonb string[]), `guardrails` (jsonb). Migration `0004_perfect_martin_li.sql`. An existing row with none
  of these set behaves exactly as before — template default / global env-configured voice+LLM+tools, unchanged.
- **`agent.ts`**: new `resolveAgentConfig()` — the org+template entry point. Same priority chain as
  `resolvePersona` for the prompt body, but also reads the frame fields and returns voice/LLM/tool overrides
  alongside the composed system prompt. `buildIdentityBlock()` composes name/greeting/closing/tone into the
  prompt; `withCallControl()` now takes `guardrails` and varies its wording by strictness level instead of
  one fixed block for every agent. `filterVoiceTools()` narrows the tool set per agent — `hangUp` always
  stays available regardless (safety default, not a togglable feature).
- **`llm/index.ts`**: `resolveVoiceModel`/`getActiveModelLabel` take an optional `modelOverride` — an agent's
  `llmModel` bypasses the env-configured default for its provider without a redeploy.
- **`tts/*.ts`**: `ConnectTts` takes an optional `voiceId` override, threaded through `cartesia.ts` /
  `elevenlabs.ts` / `tts/index.ts` — an agent's `voiceId` bypasses the env-configured default voice.
- **`stream.ts`**: now calls `resolveAgentConfig` instead of `resolvePersona` directly, wiring
  `llmModel`/`voiceId`/`enabledTools` overrides through to every turn.
- **`voice/tts-preview.ts`**: one-shot TTS helper for the dashboard's "preview this voice" button — runs a
  single turn through the same `connectTts` every real call uses, collects the mu-law chunks, wraps them in
  a WAV header (`wrapMulawInWavHeader`) so any browser `<audio>` tag can play it with zero client decoding.
- **New endpoints** (`voice/routes.ts`, all `requireAdminKey`-gated): `GET /orgs` (dashboard org picker),
  `GET /orgs/:orgId/agent-configs` (every template for that org's vertical, merged with its saved config row
  if any), `PUT /orgs/:orgId/agent-configs/:templateKey` (upsert, validated against `AgentFrameSchema`),
  `POST /voice-preview` (returns playable WAV), `GET /orgs/:orgId/analytics` (call volume, dispositions, avg
  latency breakdown, tool usage, guardrail event counts — aggregated directly off existing tables, no new
  rollup tables yet).
- **Dashboard**: new `/dashboard/agents` (list + inline edit form: identity, tone, voice + live preview,
  language, LLM provider/model, tool checkboxes, guardrail strictness selects) and `/dashboard/analytics`
  (stat cards + simple bar breakdowns) pages, both org-scoped via a picker (no org-switcher/auth
  infrastructure exists yet — one shared admin key sees every org, same as the rest of the dashboard).
- New tests: `tts-preview.test.ts` (WAV header correctness), `llm/index.test.ts` additions for
  `modelOverride` behavior.

## 2026-07-10 — Fixed: agent_templates seeding bug (D5, flagged during agent-frame smoke test)

`agent_templates` was completely empty in prod despite `[db-seed] Agent templates seeded successfully.`
logging on every boot, in every environment, since this table was introduced. Root cause: `seed.ts`
computed `promptsDir` as `packages/docs/agent-prompts` (3 `..` levels up from
`packages/api/src/database`) — the real files live at `<repo-root>/docs/agent-prompts`, one level
further up. Every `Bun.file(...).exists()` check silently returned false, so all 3 templates hit the
`continue` branch and were skipped — while the function still logged an unconditional success message
at the end regardless of whether anything was actually written. This is exactly why the Agents
dashboard page showed zero templates during today's smoke test.

Fixed: corrected the path (4 `..` levels), and the success log now reflects what actually happened
(`"N/3 seeded, M skipped — see errors above"` when anything was skipped, instead of always claiming
full success). New regression test `database/seed.test.ts` hits the real filesystem (deliberately not
mocking `Bun.file`) so a repeat of this exact path bug fails the test the same way it silently broke
production. No manual DB fix needed — the corrected seeder self-heals `agent_templates` on next boot.

## 2026-07-10 — Admin dashboard rebuilt to match Vocalist's real admin structure + real landing page

Rebuilt `/dashboard` nav and pages to mirror what Vocalist actually ships as an admin panel, instead of
the ad-hoc set that had accumulated here. Added: **Users** (org members list, was missing entirely),
**Waitlist** (`GET /api/voice/waitlist`, reads the new `waitlist_signups` table), **Broadcasts** (compose +
send to a segment, `broadcasts` table, only marks `status: "sent"` when `RESEND_API_KEY` is configured and
the email actually goes out — otherwise `"queued"`, never fabricated), **Support** (merchant-submitted
tickets via new `POST /app/support`, admin list + reply view via `support_tickets` table), **Logs**
(reads `admin_audit_log`, now also written to by the flags and impersonation admin mutations, not just a
placeholder), **Revenue Analytics** and **Marketing Analytics** — both explicitly framed as proxies (usage
minutes for revenue, waitlist signups for marketing) since no Stripe/Razorpay or funnel-tracking
integration exists yet; the pages say so on-screen rather than presenting the numbers as real
revenue/funnel data.

**Impersonate removed as a standalone nav page** — the capability and its audit trail (start/stop,
active-sessions list, full history) are not gone, they now live inside the new Users page ("Log in as"
action per row + an audit trail section), matching how Vocalist surfaces it. `/dashboard/impersonate`
route and file deleted.

**New public, unauthenticated routes** (`app/public-routes.ts`, mounted at `/api/public`, deliberately
separate from the admin-key-gated and Supabase-session-gated routers so "needs zero auth" stays obvious
from the file): `POST /api/public/waitlist`, `POST /api/public/support`.

**Landing page** (`pages/landing.tsx`, mounted at `/`, replacing the old unconditional redirect to
`/dashboard`): hero, 3-feature strip, waitlist signup form posting to `POST /api/public/waitlist`, footer
link to merchant login. Dark monochrome theme (`.theme-weeber`, ADR-039) applied the same way the
merchant login page does it — wrapped at the page root, not a new global default. Structure loosely
informed by Vocalist's landing/waitlist pages (read-only reference, no code copied — Vocalist stays
advisor-only, no repo access).

**Schema**: new tables `admin_audit_log`, `broadcasts`, `support_tickets`, `waitlist_signups`, plus
`org_members.email` — all additive, migration `0006_chilly_blur.sql`.

Compliance/DNC dashboard page is unchanged. Full verification before commit: `packages/api` tsc + 129/129
tests, `packages/openvent-compliance` tsc + 25/25 tests, `packages/web` tsc + 8/8 tests + production build,
root `oxlint` — all clean.

## 2026-07-10 — Database audit fixes

- **`supabase/config.toml`**: updated `gdpr-redact-notify` to `verify_jwt = true`, matching the live
  deployment state. The backend already passes `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` when
  calling this function (see `integrations/shopify/routes.ts` line 376).
- **Performance indexes** (migration `0010_performance_indexes.sql`, applied to live DB):
  - `calls_org_id_idx` on `calls.org_id` — dashboard filters calls by org.
  - `transcripts_call_id_idx` on `transcripts.call_id` — transcript listing per call.
  - `scheduled_calls_org_id_idx` on `scheduled_calls.org_id` — org-scoped scheduled call queries.
  - `scheduled_calls_status_run_at_idx` on `scheduled_calls(status, run_at)` — the scheduler sweep's
    `WHERE status = 'pending' AND run_at <= now()` query path.
- **Schema file** (`database/schema.ts`): index definitions added to `calls`, `transcripts`, and
  `scheduledCalls` table configs so future `drizzle-kit generate` stays in sync.
