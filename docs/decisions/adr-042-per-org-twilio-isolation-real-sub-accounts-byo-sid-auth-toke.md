---
adr: 42
title: "Per-org Twilio isolation: real sub-accounts + BYO (SID + auth token + number)"
date: 2026-07-10
status: Accepted
---

## ADR-042 — Per-org Twilio isolation: real sub-accounts + BYO (SID + auth token + number)

**Date:** 2026-07-10

**Context:** ADR-030 explicitly deferred this — "no per-org Twilio sub-account... see
WEEBER-PLAN.md Phase 2 for what's deferred." Every org's calls ran through one shared platform
Twilio account (global `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), fine for a single-tenant/
self-hosted deployment but wrong for the multi-tenant product: no per-merchant Twilio billing/usage
isolation, and a merchant who already owns a Twilio account had no way to use it instead of the
platform's.

**Decision:** Added two real per-org Twilio modes, stored on `orgs.twilioMode` ("platform"|"byo",
default "platform" — every existing org keeps today's exact behavior, riding the global env
credentials, until an admin explicitly provisions something):
- **Platform sub-account:** the parent Twilio account (global env credentials) creates a real Twilio
  sub-account via the Accounts API (`twilioClient.api.v2010.accounts.create`); that sub-account's own
  SID + auth token get stored on the org row. Buying a number for it is a separate step
  (`buyNumberForOrg`) using a client scoped to the *sub-account's own* credentials — Twilio requires
  this, a sub-account's numbers can't be bought by the parent on its behalf.
- **BYO:** merchant pastes their own Account SID + Auth Token + existing number. Validated against
  Twilio's own API (`accounts(sid).fetch()`, checked for `status === "active"`) before anything is
  persisted — a bad credential fails immediately here, not on the first real call three steps later.
- Both modes reuse the existing `orgs.outboundNumber` column for the phone number — no new column
  needed there.

`getTwilioClientForOrg(orgId)` (voice/twilio-client.ts) resolves the right client per call — org's
own credentials if configured, else the platform default — with a DB lookup on every call rather than
a cache, since a stale cached client after a credential rotation would silently keep using a revoked
token. Every real call-placing/modifying site now resolves through it: the outbound-call trigger,
admin force-end, AMD machine-answer redirect, in-call hangup/transfer (stream.ts), the workflow
scheduler's retry dial, and the workflow engine's SMS action.

**Critical correctness issue found and fixed while implementing:** `requireTwilioSignature`
validated every webhook (`/incoming`, `/status-callback`, `/recording-status`,
`/amd-status-callback`) against one global `TWILIO_AUTH_TOKEN`. Twilio signs a webhook with the auth
token of whichever account actually placed/owns that call — for a sub-account or BYO org, that's a
different token than the platform default. Left unfixed, every one of those orgs' webhooks would
have been silently rejected as invalid signatures the moment this feature shipped. Fixed by resolving
the right token per request: `CallSid` -> `calls.orgId` (covers status/recording/AMD callbacks, and
the outbound leg of `/incoming` once its call row exists) -> falls back to dialed number (`To`) ->
`orgs.outboundNumber` (covers a genuinely fresh inbound call with no DB row yet) -> global token as
the final fallback (unchanged behavior for platform-only orgs). Added
`voice/middleware/twilio-signature.test.ts` covering all four resolution paths, since this had zero
test coverage before and is exactly the kind of bug that only surfaces in production against a real
sub-account.

**Security note:** the raw Twilio auth token is never returned by any API response — not
`GET /orgs/:orgId` (previously did leak it via `db.select().from(orgs)` spreading into a generic
admin JSON blob, fixed as part of this change), not `/orgs/overview`, not the new
`GET /orgs/:orgId/twilio` status endpoint (masked SID only, `usingGlobalDefault` flag, no token
field at all). Admin actions that touch it (`twilio.subaccount.created`, `twilio.byo.set`,
`twilio.reset`) log the action and non-secret metadata (SID, phone number) to the audit log, never
the token itself.

**Admin surface:** added a Telephony section to the existing org-detail expand panel
(`dashboard/orgs.tsx`) — status display (mode, masked SID, number), create-sub-account / buy-number
actions for platform mode, a BYO credentials form, and reset-to-platform-default. No merchant-facing
(`/app`) UI yet — this is an ops/admin action for now, not something a merchant self-serves; that's a
natural follow-up, not built here.

**Consequences:** No existing org affected — new columns nullable/defaulted, `getTwilioClientForOrg`
falls through to the exact same global client as before when nothing org-specific is configured.
Verified: api tsc + 134/134 tests (4 new), web tsc + tests + build, openvent-compliance tsc + 25/25
tests, root lint — all clean.
