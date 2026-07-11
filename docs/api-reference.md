# API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Pipeline health, active providers, compliance config |
| POST | `/api/voice/incoming` | Twilio webhook — returns TwiML to start the media stream (signature-verified) |
| POST | `/api/voice/calls/outbound` | Trigger an outbound call: `{ to, persona?, webhookUrl? }` (compliance-gated, rate-limited, admin-key gated) |
| GET | `/api/voice/calls/:id/status` | Current status/metadata for one call (admin-key gated) |
| POST | `/api/voice/calls/:id/end` | Force-end a live call (admin-key gated) |
| GET | `/api/voice/calls` | List all calls (admin-key gated) |
| GET | `/api/voice/calls/:id/transcript` | Full transcript for one call (admin-key gated) |
| GET | `/api/voice/calls/:id/tool-calls` | Full tool-call log for one call, including captured-state writes (admin-key gated) |
| GET | `/api/voice/calls/:id/latency` | Per-call latency breakdown — STT connect, LLM time-to-first-token, TTS first byte. Null fields for calls that ended before that stage or predate this feature (admin-key gated) |
| GET | `/api/voice/calls/:id/audit` | Compliance audit trail for one call — plain text (`?format=text`) or JSON (admin-key gated) |
| GET | `/api/voice/callers/:phoneNumber/audit` | Compliance audit trail for every call involving a number (admin-key gated) |
| GET/POST | `/api/voice/dnc` | List / add to the Do-Not-Call list (admin-key gated) |
| DELETE | `/api/voice/dnc/:phoneNumber` | Remove a number from the DNC list (admin-key gated) |
| DELETE | `/api/voice/callers/:phoneNumber` | GDPR right-to-erasure — deletes all data for a number (admin-key gated) |
| POST | `/api/voice/webhooks/test` | Send a sample event to a webhook URL for testing (admin-key gated) |
| POST | `/api/voice/admin-keys` | Create a labeled admin key — returns the plaintext key once, never again (admin-key gated) |
| GET | `/api/voice/admin-keys` | List labeled admin keys (label, created/last-used timestamps, revoked status — never the key itself) (admin-key gated) |
| DELETE | `/api/voice/admin-keys/:id` | Revoke a labeled admin key (soft-delete — sets revokedAt) (admin-key gated) |
| WS | `/api/voice/stream` | Twilio Media Stream connection (internal, used by Twilio only) |

Full request/response shapes and the in-app version of this table are on the running app's `/docs` page.
