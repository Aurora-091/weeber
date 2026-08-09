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

See also `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md` for a source-level audit of
the Agents UI framework paired with COGS/unit-economics analysis — kept under `docs/` rather than here
since it's half product/GTM content, not a pure code audit.
