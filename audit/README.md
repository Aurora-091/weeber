# Audit log

Dated, point-in-time code audits — each one is a snapshot of "what does the codebase actually do
right now", not a plan or a spec. If a finding here is stale, the code has moved on since; check
[`docs/decisions/README.md`](../docs/decisions/README.md) / [`docs/changelog/README.md`](../docs/changelog/README.md)
for what happened after. Files are named `YYYY-MM-DD-audit-NN[-topic].md`
and are read chronologically, oldest first.

- **`2026-07-10-audit-01.md`** — first backend audit pass.
- **`2026-07-12-audit-02.md`** — follow-up backend audit.
- **`2026-07-13-audit-03.md`** — follow-up backend audit.
- **`2026-07-13-audit-04-uiux.md`** — first UI/UX-focused audit (admin panel + user dashboard).
- **`2026-07-15-audit-05.md`** — follow-up backend audit.
- **`2026-07-15-audit-06-db-systems.md`** — database/systems-focused audit (schema, migrations,
  Postgres/Supabase setup).
- **`2026-07-15-review-outbox-vault-versioning.md`** — targeted review of the outbox pattern, secrets
  vault, and versioning approach.
- **`2026-07-17-audit-07-live-infra.md`** — audit covering live infrastructure as currently deployed.
- **`2026-07-30-audit-08-workflow-canvas-ux.md`** — cold UX audit of the merchant
  workflow builder (Standard view / canvas / AI-draft) + competitive matrix; drove the P0 persona-dropdown
  and AI-draft-front-door fixes shipped the same day.
- **`2026-08-09-audit-09.md`** — pre-pilot risk audit at `cf929b0`. Baseline verified
  green (typecheck/lint/1111 tests) after 60 commits of drift; correctness is largely retired, so findings
  are operational — no spend/usage ceiling (P0), fail-open admin gate, unreaped `claimed` scheduled calls,
  Plivo/Exotel secrets leaking to the admin browser, transitional vault still dual-writing plaintext,
  PII in logs, 9 high dependency vulns with no supply-chain CI job, and detection-without-notification
  across health/spend/scheduler. Source-level only — no DB, deploy, traffic, or analytics access.
- **`2026-08-09-audit-10-outbound-hangup.md`** — most recent audit: root-cause diagnosis, confirmed
  against production DB + Railway logs, of "calls drop right after the greeting". The caller-silence
  timer is armed when TTS finishes *sending* audio rather than when Twilio finishes *playing* it, so
  any turn over 8s of speech makes the agent hang up on itself mid-greeting. 6/6 production calls
  affected, inbound and outbound; all six recorded `health_status = healthy`. The browser test-call
  path has no silence timer at all, which is why the preview appeared to work. Unresolved merge tags
  (no lead-field binding) are an aggravator: they force the slower LLM greeting, pushing it past the
  8s threshold. AMD was ruled out. Includes mark-event-based fix proposal.

- **`2026-08-09-audit-11-catalog-and-jurisdiction-structure.md`** — structural audit of two questions:
  (a) is the premade-vs-bespoke agent model right, and (b) on what axis should India and non-India be
  separated. Verdict: both structures are correct in shape and under-enforced in practice. The three-layer
  catalog model (`visibility`/`ownerOrgId` → `org_agent_configs`) is the right one, but visibility is applied
  in only 4 of ~10 reads of `agent_templates` — the merchant-facing `templateKey` path is unguarded, so
  `POST /api/app/agent-configs/:templateKey/test-chat` hands another org's private persona prompt to a chat
  the caller controls (P0). Region: the jurisdiction-pack resolver in `weeber-compliance` is already the right
  axis (per-call, recipient-based, not per-org) but only the calling window consumes it — provider chains,
  disclosure text, number series and licensing are each decided from a different input, which is how a US
  call can fail over into an Indian-accented Sarvam voice (P0) and how an unrecognized number silently gets
  US TCPA rules (P1). 8 findings, two proposed ADRs.

- **`2026-08-10-audit-12-agent-enablement-and-vertical-drift.md`** — opened to explain "I can't see the
  new agent in the old accounts", which turned out not to be a bug: the agent list filters on the org's
  `vertical` + `active` only, so the new insurance template is correctly invisible to the one shopify org
  and correctly visible to all three insurance orgs regardless of provisioning. Two real defects found
  while confirming it, both the ADR-091 shape (enforced on the browse path, ignored on the execution
  path): `org_agent_configs.enabled` is read in exactly 2 cosmetic places and **nowhere** on the call
  path, so the UI's "Paused" pill is decorative and a paused agent still answers and dials (P0, confirmed
  live — `rishipawar8999`/`insurance-post-sale-welcome` is paused with an active number); and
  `PATCH /settings` writes `vertical` with no cleanup, leaving off-vertical config rows that the list
  query hides but the resolver still reaches — 3 such ghost rows in production, one holding an active
  caller ID (P1). Includes the one enforcement decision (inbound call to a paused agent) that is a
  product call, not an engineering one. 3 findings, one proposed ADR.

See also `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md` for a source-level audit of
the Agents UI framework paired with COGS/unit-economics analysis — kept under `docs/` rather than here
since it's half product/GTM content, not a pure code audit.
