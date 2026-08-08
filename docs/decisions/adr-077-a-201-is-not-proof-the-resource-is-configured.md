# ADR-077: A 201 is not proof the resource is configured

- **Date:** 2026-08-08
- **Status:** Accepted
- **Supersedes / relates to:** ADR-073 (a repair path with no caller is not a repair path), ADR-042 (per-org Twilio isolation)

## Context

`buyNumberForOrg` resolves `inboundVoiceWebhooks()` before purchasing, then calls
`incomingPhoneNumbers.create({ phoneNumber, ...webhooks })`, then records the number. If `create`
did not throw, it returned `ok: true`.

Every number this platform has ever bought — both of them — came back from Twilio with `voice_url`
and `status_callback` **unset**. An inbound call to such a number reaches Twilio's default "not in
service" message and no webhook ever arrives, so the number is inert: it rings and drops. Both
purchases were reported to the user as successful. Both were repaired by hand on 2026-08-08 through
the admin `sync-webhooks` route (ADR-073), which fixed each on the first try.

What the investigation ruled out, by command rather than by reasoning:

- **Stale build.** `aad7029` (which added the webhooks to the create call) deployed
  2026-08-05T10:12:47Z. The two purchases ran at 2026-08-05T12:11:11Z on `adc07d4` and
  2026-08-08T17:25:01Z on `439650a` — two independent builds, two different Twilio accounts, three
  days apart, same outcome. `git show 439650a:packages/api/src/voice/twilio-provisioning.ts`
  provably contains the create call with the webhooks spread into it.
- **A second, older purchase path.** `rg` finds exactly one `insert(orgPhoneNumbers)` and exactly
  one `incomingPhoneNumbers.create` in the codebase. Both numbers are in `org_phone_numbers`, so
  both came through this function.
- **SDK serialisation.** Driving the real `twilio@6.0.2` client with a recording `httpClient` shows
  `{ phoneNumber, ...webhooks }` serialising to `PhoneNumber`, `VoiceUrl`, `VoiceMethod`,
  `StatusCallback`, `StatusCallbackMethod` on a `POST` to
  `/2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json`. Nothing is dropped.
- **`voiceApplicationSid` / `trunkSid` overriding `voice_url`.** Twilio documents these as the only
  case where `voice_url` on create is ignored. Both are `(none)` on all three numbers in the fleet.

And what Twilio itself says. The Monitor audit trail for each number's `phone-number.created` event
lists `resource_properties` containing `friendly_name`, `sms_fallback_method`, `sms_method`,
`status_callback_method`, `voice_fallback_method`, `voice_method` — and **no `voice_url`, no
`status_callback`**. The later repair event records `voice_url: {previous: None, updated: …}`, which
confirms the field was never set rather than set and lost.

**The root cause is not proven.** Our code, the deployed build and the SDK are all provably correct,
yet Twilio received no `VoiceUrl`. What remains untested is something between the container and
Twilio, or a Twilio-side behaviour their docs do not cover. The one decisive experiment — buying a
number on a known-good build and reading its create event — costs real money and has not been run.

The existing test suite could not have caught this and still cannot. `twilio-provisioning.test.ts`
mocks the `twilio` module wholesale and asserts the JavaScript arguments we pass it. A parameter
lost between the SDK and the HTTPS request is invisible to a test that hands our own arguments back
to us.

## Decision

**Verify the resource's state from the provider's own response instead of inferring it from the
absence of an exception.**

1. `buyNumberForOrg` reads `voiceUrl` and `statusCallback` off the `create` response. On mismatch it
   issues `incomingPhoneNumbers(sid).update(webhooks)` and re-checks the update response.
2. The `org_phone_numbers` row and `orgs.outboundNumber` are written **even when the webhooks could
   not be set**. The org is billed from the moment `create` returned, and a number that exists in
   Twilio but not in `org_phone_numbers` is invisible to `syncNumberWebhooksForOrg` — which is
   exactly how the platform's legacy `TWILIO_PHONE_NUMBER` number ended up carrying a dead
   `trycloudflare.com` webhook that no repair path can reach.
3. When it still does not match, the call returns `ok: false` with an error that names the real
   state: bought, recorded, billable, will not answer calls, retry the webhook sync or release it.
4. `remoteMatchesWebhooks` is now the single rule for "correctly configured", shared by the purchase
   path and `syncNumberWebhooksForOrg`. It compares `statusCallback` as well as `voiceUrl`: a number
   with the right `voiceUrl` and no `statusCallback` answers calls and then silently drops every
   completion event, so duration, status and cost never land. The sync path previously compared
   `voiceUrl` alone and would have called such a number healthy.
5. A new test file, `twilio-purchase-webhook-wire.test.ts`, drives the **real** SDK through a
   recording `httpClient` and asserts the serialised request body. It imports the client by its deep
   CJS path (`twilio/lib/rest/Twilio.js`) because sibling test files call `mock.module("twilio")` and
   those mocks are process-wide.

This is correct regardless of which unproven cause turns out to apply, which is why it ships without
waiting for the diagnosis.

## Consequences

- A silently unconfigured number now self-heals on purchase, and when it cannot, the user is told
  the truth instead of "purchased successfully".
- The purchase route returns HTTP 400 with that message. A 400 after a real charge is imperfect, but
  the message names the state and the number, and the row exists — so the admin sync route can
  finish the job.
- Retrying the legacy auto-provision route after such a failure now hits its own
  "already has a dedicated number" 409 guard, because `orgs.outboundNumber` was set. That is the
  desired outcome: retrying must not buy a second number. The fix is the webhook sync, not a repurchase.
- One extra Twilio API call per purchase, only on the failure path.
- The wire-contract test fails if an SDK upgrade renames or stops serialising any of these params, or
  if `NumberVoiceWebhooks` grows a field Twilio would silently ignore. It does **not** fail without
  the fix — it locks a contract the fix relies on. The behavioural proof is in
  `twilio-provisioning.test.ts`: two of its four new cases fail when the source change is stashed.
- The root cause remains open. If a future purchase logs a create response that already carries the
  webhooks, that is evidence the original failure was environmental and transient. If it comes back
  unset again, the repair path will cover it and the investigation has a fresh, observable data point.

## Outcome (same day, after the fix shipped)

The decisive experiment was authorised and run: one number bought on `b479532` into
`org_58c7d5cc` — the same sub-account as the 2026-08-05 failure — then released immediately
(`DELETE` → HTTP 204).

**It succeeded.** The purchase returned HTTP 201, and its Monitor `phone-number.created` event
carries `voice_url` and `status_callback` set to the correct production URLs. There is no
`phone-number.updated` event, so the verify step found nothing to repair — `create` itself worked.
Identical code, identical SDK, opposite result. **The failure is intermittent, not deterministic**,
which corrects this ADR's original "failure reproducible" framing.

The discriminator is the **egress IP recorded on each create event**:

| Purchase | Source IP | Owner (RDAP) | `voice_url` at create |
|---|---|---|---|
| 2026-08-05 12:11 | `34.143.171.53` | Google LLC | **absent** |
| 2026-08-08 17:25 | `34.143.171.53` | Google LLC | **absent** |
| 2026-08-08 19:55 | `208.77.246.75` | Railway (`RLWY-METALGEN1-02`) | present |

Both failures egressed from Railway's GCP-backed runtime; the success egressed from Railway Metal.
The service moved between the two during the day's redeploys — we did not move it deliberately.

The second, sharper clue is **which** parameters went missing. `friendly_name`, `voice_method`,
`status_callback_method`, `sms_method` and `voice_fallback_method` all arrived on every attempt.
The only two that ever vanished were `voice_url` and `status_callback` — **exactly the two
URL-valued fields**. Every scalar got through, both times. A transport that drops URL-valued form
fields while preserving every other field in the same request body is the signature of something
inspecting and rewriting the request in the egress path, not of a Twilio-side default or an SDK bug.

This is strong evidence, not proof: the failing runtime no longer exists to reproduce on, so the
mechanism cannot be confirmed from here. It does, however, close out every hypothesis that pointed
at our own code, and it upgrades the read-back from "correct under every hypothesis" to "the only
thing standing between a merchant and an inert paid number if the service is ever scheduled back
onto that runtime". The `create`-carries-webhooks path is now the observed norm, so the repair
branch should be treated as a live safety net rather than dead code — worth a log line if it ever
fires again.

Cleanup owed from the experiment: `buyNumberForOrg` also overwrote `orgs.outboundNumber` and left an
`org_phone_numbers` row marked `active` for a number that no longer exists. Releasing off Twilio's
API fixes neither. Two guarded `UPDATE`s restore both. That the experiment needed hand-written SQL
to undo is itself a finding: there is no admin-side release route, and `closeOrgTelephony` still has
no caller — the same dead-code shape ADR-073 was written about.

## Alternatives considered

- **Release the number when the webhooks cannot be set.** Rejected: destructive, and the number is
  repairable — both real cases were repaired with a single `update`. Releasing would also destroy the
  evidence.
- **Not insert the row on failure**, to avoid recording a broken number. Rejected: that is precisely
  the shape that made the legacy platform number unrepairable, and it hides a live charge.
- **Move the webhooks off the number onto a shared `voiceApplicationSid`.** A TwiML App would make
  `voice_url` a property of one re-pointable resource instead of every number. Rejected here for the
  reason already documented on `inboundVoiceWebhooks`: it is a second Twilio resource to provision,
  version and reconcile per sub-account, and it would not have prevented this — an app SID dropped on
  create fails the same way.
- **Always `update` after `create`, unconditionally.** Simpler, one fewer branch. Rejected: it spends
  an API call on every purchase and, worse, it would have made this defect permanently invisible
  instead of reported.
- **Retry `create` on mismatch.** Rejected outright: a second `create` buys a second number.
- **Wait for the root cause before shipping anything.** Rejected: the read-back is correct under
  every hypothesis, and the current state is that a merchant can pay for a number that cannot take a
  call.
