# Phase 2+3 build — live progress (scratchpad)

> ✅ **COMPLETE (2026-07-19)** — all backend, frontend, tests, docs, and verify+ship done. Shipped verified (typecheck/test 621-pass/lint/build all clean). See changelog 2026-07-19 + ADR-061.

## Backend
- [x] schema-store.ts (resolver + editor CRUD + validateSchemaDefs) — written
- [x] ingest.ts uses resolveIntakeSchema
- [x] leads.ts: import fixed, promoteLeadFromCall + createLeadManual use resolver
- [x] export.ts buildLeadsWorkbook uses resolver
- [x] routes.ts: GET/PUT/DELETE /leads/intake-schema, POST /leads/:id/sync-crm
- [x] resolve-crm.ts (shared getOrgCrmCredentials) + crmSync.ts refactored
- [x] crm-mirror.ts (mirrorLeadToCrm)
- [x] typecheck --force PASSES
- [x] Phase 3 hosted form public endpoints (public-routes.ts) GET/POST /public/leads/:orgId/form

## Frontend
- [x] intake-schema editor UI in leads.tsx (Configure fields dialog)
- [x] Sync to CRM button on LeadDetailSheet
- [x] hosted form public page /f/:orgId in app.tsx

## Tests
- [x] schema-store.test.ts (regulated reject, resolver fallback order, null-agent no-dup)
- [x] crm-mirror.test.ts
- [x] hosted-form validation test

## Docs
- [x] docs/integrations/leads-ingest-api.md
- [x] docs/integrations/pipedream-inbound-recipe.md
- [x] native-leads-layer-plan: mark phases done, relabel ingest/api-keys → Phase 2, Orders-migration deferred
- [x] leads-layer-build-task.md relabel note
- [x] docs/changelog/2026-07.md entry
- [x] adr-061 if a real decision (leaner-Phase-1 relabel / orgId-as-form-token)

## Verify + ship
- [x] bun install --frozen-lockfile
- [x] bun run test --force
- [x] bun run typecheck --force
- [x] bun run lint
- [x] bun run build
- [x] commit + push main
