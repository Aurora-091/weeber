---
adr: 49
title: "Real Plivo/Exotel call transport — provider wire-format abstraction + a correction (2026-07-12)"
date: 2026-07-12
status: Accepted
---

## ADR-049: Real Plivo/Exotel call transport — provider wire-format abstraction + a correction (2026-07-12)

**Context:** ADR-048 wired up Plivo/Exotel BYO credentials only — no real call ever routed through
either. User pushed back: credentials with no working calls "has no purpose," and competitors (Bolna
etc.) have real SIP-trunk/telephony integrations, so this needed to actually work, not just store keys.

Live protocol docs were fetched directly from Plivo and Exotel while building this (not assumed from
training knowledge or the earlier india-telephony.md research). **Finding that corrects earlier research:
Exotel is no longer SIP-trunk-only.** Its AgentStream product now ships a real bidirectional WebSocket
(VoiceBot Applet) structurally close to Twilio Media Streams — the "Exotel needs a LiveKit SIP bridge"
framing in `docs/india-telephony.md` is outdated and has been corrected in that doc (kept further down as
historical record, not current guidance).

**Decision — built a real per-provider transport layer, not just more BYO:**
- `voice/telephony-transport.ts`: normalizes all three providers' wire formats to one shape
  (`start`/`media`/`stop`, always mu-law 8kHz) that `stream.ts`'s actual conversation logic consumes,
  unchanged. Twilio and Plivo already speak mu-law — only field-naming differs (`streamSid`/`callSid` vs
  `streamId`/`callId`, `media`/`clear` vs `playAudio`/`clearAudio`). Exotel speaks raw linear16 PCM, not
  mu-law — transcoded at the boundary only (new `pcm16ToMulaw` in `voice/audio-codec.ts`, paired with the
  pre-existing `mulawToPcm16`).
- `stream.ts`: `createVoiceStreamHandlers(provider)` takes the provider explicitly and does all wire I/O
  through the transport adapter. STT/TTS/agent turn logic is byte-for-byte unchanged — this was a
  boundary-only refactor, confirmed by `stream.test.ts`'s pre-existing pure-function tests still passing
  untouched.
- `ws-route.ts`: three WS paths, one per provider (`/api/voice/stream`, `/stream/plivo`, `/stream/exotel`)
  — provider is known from which path was hit, not sniffed from the first message.
- `voice/plivo-client.ts` / `voice/exotel-client.ts`: outbound call placement, each provider's real API.
  Plivo mirrors Twilio's call-then-webhook-returns-XML shape (reuses one `/incoming/plivo` route for both
  inbound and outbound). Exotel's `/calls/connect` is a single direct API call with no separate XML
  round-trip — a genuinely different shape, not just a different SDK.
- `voice/middleware/plivo-signature.ts`: validates Plivo's `X-Plivo-Signature-V3`, algorithm taken
  directly from Plivo's own docs. Org resolved via `?orgId=` on the answer_url itself, since Plivo's
  webhook can be the very first request for a fresh call with no DB row yet to resolve an org from.
- `calls.provider` column added (migration `0013_organic_whizzer.sql`, single-column diff). `stream.ts`'s
  start handler gained a lazy-insert fallback for Exotel specifically (no separate inbound webhook
  pre-creates the row the way Twilio/Plivo's do).
- Mid-call hang-up/transfer (`performHangUp`/`performTransfer`) stay Twilio-only, but now explicitly
  warn-and-fall-back instead of silently calling the wrong provider's REST API for Plivo/Exotel calls.
- New `voice/telephony-transport.test.ts`: wire-format parse/build coverage for all three providers plus
  a real mu-law<->PCM16 round-trip test (sine wave + silence) — this is confidence in the protocol
  translation logic, not a substitute for a live call.

**Explicitly still open — flagged, not silently assumed correct, because no live prototype call was
possible in this environment (no real Plivo/Exotel account, no public WS URL, nothing to receive a call
on):**
- Whether Plivo's `request_uuid` (returned immediately from Call Create) equals the real `CallUUID` the
  WS `start` event later carries — the code is written so this isn't load-bearing either way (the answer
  webhook, not the create response, is where session/org context gets bound to the real CallUUID).
- Whether Exotel's `/calls/connect` response `call.sid` matches the WS `start` event's `call_sid` — same
  non-load-bearing treatment via `stream.ts`'s lazy-insert fallback.
- Real mid-call transfer/hangup APIs for Plivo (`Call.transfer`) and Exotel (Legs API transfer action) —
  not implemented this pass.

**Consequences:** Verified: `packages/api` tsc clean, full `bun test` suite green (174 tests, 1 pre-existing
unrelated failure in `getActiveModelLabel` — an env-default-model naming mismatch untouched by this work).
Found and fixed one **pre-existing test fragility** along the way: `routes.test.ts`'s
`mock.module("./middleware/admin-auth", ...)` stopped intercepting the moment routes.ts gained *any*
additional import — reproduced with a zero-dependency dummy import, so it's a Bun `mock.module` quirk
tied to import-graph shape, not a logic bug in this change. Fixed by having the test explicitly clear
`process.env.ADMIN_API_KEY` (a real value was leaking in from `packages/api/.env`) so the real
`requireAdminKey` falls through to its own no-op path even if the mock doesn't apply — makes that test
robust against the next unrelated import, instead of quietly re-breaking again.
