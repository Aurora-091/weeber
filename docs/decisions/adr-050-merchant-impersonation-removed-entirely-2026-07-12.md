---
adr: 50
title: "Merchant impersonation removed entirely (2026-07-12)"
date: 2026-07-12
status: Accepted
---

## ADR-050: Merchant impersonation removed entirely (2026-07-12)

**Context:** Impersonation ("Log in as" from the Users/Orgs admin pages, `X-Weeber-Impersonation`
token auth path, `impersonation_sessions` audit table) was built per CLAUDE-BUILD-BRIEF.md §4 point 6
as a hard-audited admin capability. User decided to remove it completely rather than keep it around
as unused surface area — no replacement (e.g. a read-only admin view of an org) requested, at least
for now.

**Removed:**
- Backend: `app/impersonation.ts` + its test file (deleted), the `X-Weeber-Impersonation` branch in
  `requireMerchantSession` (middleware/supabase-auth.ts — now Supabase-session-only, no dual auth
  path), `POST /api/app/impersonation/stop`, `POST /api/voice/impersonation/start`,
  `POST /api/voice/impersonation/:id/stop`, `GET /api/voice/impersonation/audit`, and the
  `activeImpersonations` field on the admin org-detail response.
- Frontend: the "Log in as" action + audit trail UI on the Users page, the "Impersonate Workspace"
  button on the Orgs page, `ImpersonationBanner` + all impersonation branching in
  `merchant-shell.tsx` (now a single Supabase-session gate, no `impersonating` flag), and the
  impersonation-token helpers in `lib/merchant-session.ts`.
- Database: `impersonation_sessions` table dropped via migration (see changelog.md) — historical
  impersonation audit rows are gone, not archived. User explicitly chose this over keeping the table
  as inert clutter.
- `MerchantMe`'s `impersonated` field removed from the `/api/app/me` response contract.

**Not done:** no replacement read-only "view an org's data without acting as them" feature was built.
If admin support/debugging needs this later, it should be scoped as its own feature, not a
resurrection of impersonation's write-capable token auth.
