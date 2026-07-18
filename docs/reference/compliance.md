# Compliance

Enforced automatically — not something an integrator has to remember to wire in. The compliance layer
lives in its own standalone, framework-agnostic package — [`packages/openvent-compliance`](../packages/openvent-compliance)
(`@openvent/compliance`) — with zero dependency on Twilio, Bun/Hono, or any specific database. It's designed to
be adoptable independently of OpenVent's own pipeline (in a Pipecat, LiveKit, or fully custom voice stack);
OpenVent's own app uses it via a thin Drizzle adapter (`voice/compliance/adapters.ts`) as its own reference
integration. See the package's own README for usage outside this repo.

- **TCPA calling window**: outbound calls are blocked outside 8am–9pm in the called party's local time
  (best-effort area-code-based timezone inference, safe fallback when unresolved).
- **Do-Not-Call list**: every outbound call is checked against an internal DNC list first
  (`GET/POST /api/voice/dnc`, `DELETE /api/voice/dnc/:phoneNumber`) — also manageable from the
  [dashboard](./dashboard.md). The National DNC Registry has no free API — it requires a paid Subscription
  Account Number (SAN) via telemarketing.donotcall.gov. The internal list is fully automatic today; a
  national-registry sync adapter is a documented drop-in point once you have a SAN (see
  `packages/openvent-compliance/src/national-dnc.ts`).
- **Recording/AI disclosure**: the agent's opening line automatically states the call may be recorded and
  that the caller is speaking with an AI — default **on** (`RECORDING_DISCLOSURE_ENABLED=false` to disable,
  not recommended).
- **HIPAA guardrail**: setting `COMPLIANCE_MODE=hipaa` makes the server refuse to boot unless
  `HIPAA_BAA_CONFIRMED=true` is also set — a deliberate human checkpoint. **This is a guardrail, not a
  certification** — code cannot verify a signed Business Associate Agreement exists; you must actually
  sign BAAs with Twilio, Deepgram, your TTS provider, and your LLM provider before handling PHI.
- **GDPR retention + erasure**: call data older than `DATA_RETENTION_DAYS` (default 90, or
  `HIPAA_RETENTION_DAYS` in HIPAA mode) is purged automatically on a daily sweep.
  `DELETE /api/voice/callers/:phoneNumber` erases all data for a number on request (right to erasure).

None of this constitutes legal advice or a compliance certification — consult counsel before handling
regulated data or telemarketing at scale.
