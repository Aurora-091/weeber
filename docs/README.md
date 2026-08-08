# Docs

Reference material, plans, and research for Weeber, organized by topic. Start with
`architecture/` (sibling folder, one level up) for how the codebase itself is laid out and how a call
flows end to end — this folder is everything else: how to configure/operate it, and the reasoning
behind product/compliance/voice-quality decisions.

**New here?** The fastest path is the agent brain, not this folder: read
[`../AGENTS.md`](../AGENTS.md) (canonical entry point) → [`brain/project-brief.md`](./brain/project-brief.md)
→ [`brain/00-index.md`](./brain/00-index.md) (task → which docs to open). For setting up the code
locally: `../architecture/README.md` → `reference/getting-started.md` → `reference/configuration.md`.

## Structure

### [`brain/`](./brain/)
The agent brain — small, always-current files an AI (or human) reads first to orient without loading
170KB of history. `project-brief.md` (what Weeber is, non-negotiables, glossary), `active-context.md`
(what's being worked on right now — read every session), `progress.md` (done / next / known issues),
`00-index.md` (task → files router). The repo-root [`../AGENTS.md`](../AGENTS.md) is the entry point
into all of this.

### [`decisions/`](./decisions/)
The decision log (ADRs), one file per decision — `adr-NNN-slug.md` with frontmatter, indexed in
[`decisions/README.md`](./decisions/README.md). Split from the former monolithic `DECISIONS.md`
(2026-07-18). This is the *why* behind consequential architecture/compliance/data-model/UX choices,
including reversed ones. Never rewrite a shipped ADR — supersede it.

### [`changelog/`](./changelog/)
Running log of routine feature work (new tables/columns, endpoint params, wiring already-decided
patterns), one file per month, indexed in [`changelog/README.md`](./changelog/README.md). Split from
the former monolithic `changelog.md` (2026-07-18). For a real *decision*, use `decisions/` instead.

### [`reference/`](./reference/)
Evergreen docs describing how the system works *today*. These get updated in place as the system
changes — they don't carry a date in the title.
- `getting-started.md` — local setup, running the stack
- `configuration.md` — env vars, workflows, config surface
- `api-reference.md` — HTTP API surface (method/path/description)
- `contract.md` — the weebersh ⇄ Weeber backend integration contract (versioned, copied into both repos)
- `dashboard.md` — the operator dashboard at `/dashboard`
- `compliance.md` — the compliance layer as built (DNC, calling windows, audit trail, etc.)
- `security.md` — auth model, admin-key-gated ops endpoints
- `state-engine.md` — call/caller memory model (why transcript-as-memory isn't enough)
- `testing.md` — `bun:test` conventions
- `resources.md` — infra footprint, capacity, real numbers

### [`compliance/`](./compliance/)
Compliance-specific plans and India telephony-onboarding docs that go deeper than the `reference/compliance.md`
overview.
- `global-compliance-engine-plan.md` — India + US + EU compliance priority plan (Tier 0: done)
- `merchant-dlt-onboarding.md` — DLT + telephony onboarding for merchants calling India numbers

### [`voice-quality/`](./voice-quality/)
Everything about making the voice pipeline itself better — STT/TTS/LLM quality, latency, Hindi/Hinglish,
India-readiness.
- `voice-quality-and-india-status-2026-07-12.md` — status/gaps/priorities snapshot
- `language-support.md` — what actually works + which provider handles which language (Indic smart default, ADR-060)
- `hindi-hinglish-voice-support.md` — plan + progress on Hindi/Hinglish agents
- `india-telephony.md` — Plivo/Exotel real-call transport, protocol notes
- `llm-provider-latency-case-study-2026-07-17.md` — reducing TTFT without dropping model quality tier
- `voice-ai-breakthrough-leverage-study-2026-07-17.md` — survey of underused voice-model tech
  (OpenAI's new voice stack, Kyutai, ElevenLabs architecture) and what's actually worth picking up

### [`product-strategy/`](./product-strategy/)
GTM, competitive research, and internal reasoning artifacts — not specs, not reference. Several are
explicitly marked "not a public/decision doc" in their own header; treat them as a paper trail of
reasoning, not a source of current truth (check `DECISIONS.md` for what actually got decided).
- `strategy-2026-07.md` — strategy synthesis after real Reddit/LinkedIn feedback rounds
- `competitor-changelog-scan-2026-07-17.md` — what Bolna/Retell/Bland actually shipped in 2026
- `product-infra-and-gtm-report.md` — one-time recap report (shipped work + infra + GTM)
- `weeber-status-qa-2026-07-17.md` — due-diligence-style Q&A on stack/agents/compliance
- `agents-ux-audit-and-cogs-2026-07-17.md` — Agents UI framework audit + COGS/unit-economics
- `pricing-lock-2026-07-18.md` — **final locked pricing** (India + Global tiers, split by voice cost
  tier, full unit economics) — decided, not yet deployed to the live site/checkout; see `ADR-057`
- `infra-consolidation-audit-2026-07-18.md` — Supabase/Vercel/Railway consolidation audit — what's
  already optimal, the 3 real moves, and what to turn on that's already paid for; see `ADR-058`
- `marketing-and-consent-ui-plan.md` — marketing pages + consent/compliance settings UI plan (built)
- `morning-update-2026-07-16.pdf` — daily update snapshot

### [`insurance-vertical/`](./insurance-vertical/)
Insurance-specific vertical planning, separate from the Shopify/clinic verticals covered in
`architecture/`.
- `insurance-launch-readiness.md` — what's needed before flipping the insurance vertical on (India + US)
- `insurance-vertical-meeting-prep.md` — technical + compliance prep for insurance client meetings

### [`workflow-canvas/`](./workflow-canvas/)
The Workflow Canvas feature (React Flow-based automation builder), across its build history.
- `architecture.md` — original architecture/build spec (built; the Bolt scaffolding prompt itself is
  archived, see `archive/README.md`)
- `v2-and-multivoice-research.md` — v2 research (ElevenLabs/Bolna-informed) + multi-voice feature gap
- `v3-user-builder-plan.md` — v3 plan for user-buildable automations (n8n-style); not started —
  data model/trigger-catalog/permission-model sections still current, see `v4` for the frontend
- `v4-locked-scaffold-ai-draft-and-flow-preview-plan.md` — **current forward plan**: never-blank
  locked compliance scaffold, AI-assisted graph drafting, flow preview via a live web call; not
  started

### [`agent-prompts/`](./agent-prompts/)
Per-vertical, per-agent system prompts (cart recovery, COD confirmation, insurance, etc.). **Do not
move or rename this folder or its path** — `packages/api/src/database/seed.ts` resolves it at runtime
via a relative path from `import.meta.dir`; moving it will silently break seeding (this exact bug has
happened before).

### [`archive/`](./archive/)
Superseded/historical docs kept for git history only. See `archive/README.md` for what's there and why
each entry was archived. If you're looking for current truth, this is the wrong folder.

## Conventions

- **Dated filenames** (`*-2026-07-17.md`) mean the doc is a point-in-time artifact (research, status
  snapshot, audit) — it won't be updated in place; a newer dated doc supersedes it. Undated filenames
  under `reference/` mean the opposite: they're kept current.
- **Status banners** at the top of a doc (e.g. `> **STATUS (2026-07-16): BUILT.**`) are the fastest way
  to tell if a plan doc is still aspirational or already shipped — check those before assuming a plan
  doc describes the current state.
- For the actual decision log (what was decided and why, including reversed decisions), see
  [`decisions/README.md`](./decisions/README.md) — one file per ADR. For a running log of what shipped
  when, see [`changelog/README.md`](./changelog/README.md) — one file per month. (The old root-level
  `DECISIONS.md` and `changelog.md` are now thin stubs that redirect here.) The topic folders above
  hold the reasoning/reference material those two logs point back to — not a replacement for either.
