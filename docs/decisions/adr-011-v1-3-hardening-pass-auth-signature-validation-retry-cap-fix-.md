---
adr: 11
title: "v1.3 hardening pass: auth, signature validation, retry-cap fix, rate limiting"
date: 2026-07-05
status: Accepted
---

## ADR-011 — v1.3 hardening pass: auth, signature validation, retry-cap fix, rate limiting
**Date:** 2026-07-05

**Context:** Before treating v1 as "done," a hardening pass was needed to close the gap between "works in
a sandbox with a trusted operator" and "safe to expose publicly." Several issues existed: ops endpoints had
no auth at all; Twilio webhooks accepted any request regardless of origin (forgeable); workflow retries had
a `maxRetries` field that was never actually checked, so a bad workflow config could redial a number
forever; the scheduler could double-execute a scheduled call under concurrent ticks; outbound calls had no
rate ceiling; and `sendSms` was a stub that logged instead of sending.

**Decision:** Close all of the above in one pass, each as the smallest correct fix rather than a bigger
redesign:
- Admin-key middleware (`X-Vent-Admin-Key` vs `ADMIN_API_KEY`) in front of every ops endpoint, warn-not-crash
  if unset (keeps local dev frictionless, makes the risk visible).
- Twilio's official request-signing scheme (`twilio.validateRequest`) in front of every inbound webhook.
- Atomic `pending`→`claimed` claim (conditional `UPDATE ... RETURNING`) in the scheduler, with a reset back
  to `pending` for calling-window-deferred rows (fixing a second, related bug where those rows got
  permanently stuck as `claimed`).
- `previousAttempt`/`nextAttempt` tracking so `maxRetries` is actually enforced.
- A basic fixed-window rate limiter on `/calls/outbound`, explicitly additive to (not a replacement for)
  the existing DNC/calling-window compliance gates.
- Wired `sendSms` to `twilioClient.messages.create()` for real.
- A National DNC registry *adapter shape* (`syncNationalDncRegistry`, `NationalRegistryFetcher`), shipped
  as a documented stub (`noopNationalRegistryFetcher`) rather than a real integration — the real US
  National DNC Registry requires a SAN (Subscription Account Number) that can't be provisioned in this
  sandbox. This closes the "we said we'd design for this later" gap from ADR-007 without pretending it's
  live.
- A tunnel supervisor script (`scripts/tunnel-supervisor.sh`) that watches `cloudflared`, restarts it on
  crash, and keeps `PUBLIC_APP_URL` + the Twilio webhook in sync with the tunnel's (rotating) URL. This is
  explicitly a mitigation for the quick-tunnel stopgap from ADR-008, not a fix for the underlying problem —
  the real fix remains a named tunnel or a persistent real domain.

**Consequences:** 12 new web-app tests and 2 new compliance-package tests added (40 total across both
packages, all passing); typecheck and build both clean. Regression-verified via curl: DNC add/list/remove,
E.164 rejection on `/dnc` and `/calls/outbound`, DNC-blocked outbound call returns `403`, malformed JSON
returns `400` not `500`, unsigned Twilio webhook rejected `403`, admin-key gate returns `401`
without/with-wrong key and `200` with the correct key. npm publishing of `@openvent/compliance` (ADR-010's
"remains a separate step") is still deferred — this round is about hardening the existing surface, not
distribution.

---
