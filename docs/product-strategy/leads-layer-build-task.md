# Native Leads Layer — Phase 1 build tracker

Plan: `native-leads-layer-plan-2026-07-19.md` (approved 2026-07-19, doc committed c079b3d).

## Phase 1 checklist
- [x] 1. Schema: `leads`, `leadIntakeSchemas`, `leadApiKeys` tables + `calls.leadId` column
- [x] 2. Migration generated (drizzle-kit generate)
- [x] 3. Intake schema config — insurance default set + compliance blocklist (`voice/leads/intake-schema.ts`)
- [x] 4. Per-org ingest API keys (`voice/leads/api-keys.ts`, mirror admin-keys.ts)
- [x] 5. `POST /api/leads/ingest` — validated, deduped by (orgId,phone), idempotent on externalId, source-tagged. Full standalone tests.
- [x] 6. Core lead ops: upsertLead, promoteLeadFromCall, list/get/update/assign (`voice/leads/leads.ts`)
- [x] 7. Promote capturedState -> leads.fields at finalizeCall; associate calls by (orgId,phone) via calls.leadId
- [x] 8. Leads user API in app/routes.ts (list/search, detail w/ calls, status update, assign advisor, call-now, manual add/edit)
- [x] 9. Excel export for leads (export.ts)
- [x] 10. Frontend: insurance `Leads` nav in verticals.ts + Leads page + route
- [x] 11. Verify: test --force, typecheck --force, lint, build. Commit to main.

## Key facts confirmed from codebase
- advisor = real record: `insuranceAdvisors` table exists (id, orgId, name, npn, licensedStates...). assignedAdvisorId -> insuranceAdvisors.id nullable. RESOLVES open Q1.
- captureField writes free-form snake_case -> calls.capturedState (jsonb Record<string,string>).
- Promotion point: stream.ts finalizeCall ~line 487, right after upsertCallerMemory(humanNumberOrgId, humanNumber, capturedState, dbCallId). Mirror that call.
- Per-org key pattern: admin-keys.ts (createHash sha256, randomBytes base64url, prefix). Use prefix `wlk_` for lead keys.
- Orders page pattern: pages/app/orders.tsx (list + search + call-now + status badges). Backend listOrgOrderCalls in org-queries.ts. call-now route POST /orders/:id/call-now -> callScheduledRowNow.
- Excel: app/export.ts buildOrdersWorkbook (exceljs). Route GET /export/orders.xlsx.
- verticals.ts: config-driven nav/glossary/dashboard per vertical. insurance has NO Orders-equiv page + hasLiveIntegration:false. Add `Leads` nav entry.
- app router: packages/api/src/app/routes.ts `userApp` (requireUserSession + requireUserOrg). userOrgId from c.get("userOrgId").
- Repo rules: bun install --frozen-lockfile; bun run test (NEVER bare bun test, ADR-056); test/typecheck need --force; NO --force for lint/build. build before commit. commit direct to main.

## Decisions taken during build
- Ingest key table name: leadApiKeys, prefix wlk_.
- Pipeline stages v1: new/contacted/qualified/booked/closed + lost (fixed enum; per-org configurable deferred).
- Status auto-advance: manual in v1 (open Q deferred). Promotion sets status only on first create (new).
- ingest triggerWorkflow deferred to keep v1 tight + avoid dial-gate wiring risk; contract accepts field, returns not-yet-supported note. (revisit)
