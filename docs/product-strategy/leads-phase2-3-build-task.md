# Leads Layer — Phase 2 + 3 build tracker

> ✅ **COMPLETE (2026-07-19)** — Phase 2 + 3 built & shipped (item G/Orders-migration deferred as planned). See changelog 2026-07-19 + ADR-061.

Started 2026-07-19. Plan: `native-leads-layer-plan-2026-07-19.md`.

## Scope decision (user, 2026-07-19)
- "Leaner Phase 1" = **re-label** ingest + api-keys as Phase 2 in docs/tracker. NOTHING removed (zero risk).
- Build Phase 2 code now: intake-schema editor UI (Phase 1 shipped config only).
- Build Phase 3 code now: hosted/embeddable intake form + outbound CRM mirror.
- Orders-migration (plan item 11) = risky refactor of working Shopify code, NOT named by user → keep documented-deferred, flag it.
- Pilot API-ingest need in next 2wk = "not sure yet" → ingest stays as-is (already built).

## Phase 2 checklist
- [x] A. Re-label ingest/api-keys Phase1→Phase2 in plan + tracker (docs)
- [x] B. Per-org / per-agent intake-schema editor: backend (get/put org schema, compliance blocklist on save)
- [x] C. Intake-schema editor: frontend Settings page/section
- [x] D. Pipedream inbound recipe template + webhook-in docs

## Phase 3 checklist
- [x] E. Hosted/embeddable intake form (thin client of ingest) — public route + submit
- [x] F. Outbound CRM mirror: push leads → CRM via native adapter (Pipedrive first per integrations doc)
- [x] G. Orders-migration: DOCUMENT as deferred (do not build)

## Verify
- [x] bun install --frozen-lockfile; bun run test --force; bun run typecheck --force; bun run lint; bun run build
- [x] commit to main + push

## Docs to update at end
- [x] native-leads-layer-plan-2026-07-19.md (mark phases done, re-label)
- [x] leads-layer-build-task.md (Phase 1 tracker — note re-label)
- [x] docs/changelog/2026-07.md (new entry)
- [x] docs/decisions/ (new ADR-061 if a real decision emerges)
