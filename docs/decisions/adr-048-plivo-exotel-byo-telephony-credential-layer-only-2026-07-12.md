---
adr: 48
title: "Plivo + Exotel BYO telephony, credential layer only (2026-07-12)"
date: 2026-07-12
status: Accepted
---

## ADR-048: Plivo + Exotel BYO telephony, credential layer only (2026-07-12)

**Context:** `docs/india-telephony.md` (ADR-034-era research, generalized further pre-ADR-047)
recommended generalizing the existing Twilio BYO/platform-sub-account pattern
(`voice/twilio-provisioning.ts`, `orgs.twilioMode`/`twilioAccountSid`/`twilioAuthToken`) to Plivo and
Exotel, since real merchants in India already run one of these and won't switch providers to use
Weeber. The frontend telephony tiles for both were literal "Coming soon" placeholders with disabled
Connect buttons.

**Decision:** Wired up BYO (bring-your-own-credentials) for both, matching Twilio's validate-then-store
shape exactly:
- `orgs` gained `telephonyProvider` (`twilio`|`plivo`|`exotel`, default `twilio`) plus
  `plivoAuthId`/`plivoAuthToken` and `exotelSid`/`exotelApiKey`/`exotelApiToken`/`exotelSubdomain`
  (migration `0012_hesitant_hammerhead.sql`). `exotelSubdomain` exists because Exotel's API host is
  region-specific per account, unlike Twilio/Plivo's single global host.
- `voice/plivo-provisioning.ts` / `voice/exotel-provisioning.ts`: `get*Status` + `set*ByoCredentials`,
  validating against each provider's own Account API before persisting (Plivo: `GET
  /v1/Account/{authId}/` Basic auth; Exotel: `GET /v1/Accounts/{sid}/` Basic auth against the
  merchant-supplied subdomain, defaulting to `api.exotel.com`).
- `app/routes.ts`: `GET /api/app/telephony/status` now returns `{ provider, outboundNumber, twilio,
  plivo, exotel }` (was Twilio-only shape); new `POST /telephony/plivo/byo` and `/telephony/exotel/byo`;
  `resetToPlatformDefault` (`voice/twilio-provisioning.ts`) extended to clear all three providers'
  credentials and revert `telephonyProvider` to `twilio`, since only one provider is active at a time
  and Reset is the shared button all three cards use. Twilio's own `createSubaccountForOrg`/
  `setByoCredentials` now also stamp `telephonyProvider: "twilio"`.
- `pages/app/integrations.tsx`: Plivo and Exotel tiles are real Connect buttons now, each opening a
  credential dialog (mirrors the Twilio one) instead of a disabled "Coming soon" tile. Added a note that
  only one provider is active at a time and that Exotel is credentials-only for now (see below).

**Explicitly not built — this is the credential/account layer only, not transport:**
- No platform-owned Plivo or Exotel sub-account/number-purchase path (unlike Twilio's
  `createSubaccountForOrg`/`buyNumberForOrg`) — both are BYO-only. A merchant with nothing existing
  still defaults to Weeber's shared Twilio platform number.
- **No live call routing through either provider yet.** `voice/stream.ts` is still built against
  Twilio-shaped WebSocket Media Streams only. Plivo's own WebSocket media adapter (the doc's "closer to
  Twilio's shape, smaller lift" path) is unbuilt. Exotel's path needs a SIP-trunk bridge into LiveKit
  (or similar) per the doc — connecting Exotel credentials here does not give Exotel a working
  call-transport path; the UI says this explicitly in the Exotel dialog and the telephony section note.
  Neither vendor has had the "one real prototype call" the doc calls for before treating either
  integration as validated — that's the next real step, not part of this change.
- No change to number-series/DLT/TRAI compliance workflow (Principal Entity registration, template
  approval, etc.) — still a real unautomated business process per the doc, unaffected by this.

**Consequences:** Verified: `packages/api` tsc clean, `packages/web` tsc clean, migration generated and
reviewed (schema-only diff — orgs BYO columns + FK, no unrelated drift this time). Not yet run against a
live database (no `DATABASE_URL` in this environment) — run `db:migrate` before deploying.
