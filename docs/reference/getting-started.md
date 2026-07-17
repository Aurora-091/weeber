# Getting started

```bash
bun install

# copy env vars and fill in your keys (see Environment variables below)
cp .env.example .env

# push the database schema
cd packages/web && bun run db:push

# dev server (REST endpoints work; live call audio needs the prod server — see note below)
bun run dev

# production server (required for live call audio — the WebSocket bridge only
# runs correctly under the real Bun runtime, not Vite's dev SSR module runner)
bun run start
```

## Environment variables

**Core (required):**
```
DEEPGRAM_API_KEY=            # Deepgram live STT
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=         # e.g. +15551234567 — caller ID for outbound calls
PUBLIC_APP_URL=              # Public https URL Twilio can reach (wss derived automatically)
AI_GATEWAY_BASE_URL=
AI_GATEWAY_API_KEY=
AI_GATEWAY_EMBEDDING_MODEL=  # optional — defaults to openai/text-embedding-3-small (A3b Knowledge Base)
DATABASE_URL=                # Turso/libSQL connection string
```

**TTS provider (pick one, default is Cartesia):**
```
TTS_PROVIDER=cartesia        # or "elevenlabs" or "sarvam"
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
# Optional — pronunciation dictionary for domain terms (COD, UPI, KYC, etc.) that get
# mispronounced by default. Both required together; omitted = safe no-op. See
# docs/voice-quality/hindi-hinglish-voice-support.md Phase 3 for the exact terms and how this was
# live-verified (real before/after: "COD" was being misheard as "card" without it).
ELEVENLABS_PRONUNCIATION_DICTIONARY_ID=
ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID=
SARVAM_API_KEY=               # Sarvam Bulbul v3 — natural Indic-language voices
```
Note: ElevenLabs' free tier blocks all library voices via API (`402 payment_required`) — Cartesia's free/
Starter tier works out of the box. See [`DECISIONS.md`](../DECISIONS.md) for why Cartesia is the default.

**STT provider (pick one, default is Deepgram):**
```
STT_PROVIDER=deepgram         # or "sarvam" or "elevenlabs"
# DEEPGRAM_API_KEY is under Core above.
# SARVAM_API_KEY (shared with the TTS section above) — Saaras v3, mode: "codemix", live-verified
#   to keep English words in Latin script instead of transliterating them to Devanagari.
# ELEVENLABS_API_KEY (shared with the TTS section above) — Scribe v2 Realtime, live-verified with
#   real Hinglish audio to do the same. Currently the agents-tab UI's recommended default for
#   Hindi/Hinglish agents — see docs/voice-quality/hindi-hinglish-voice-support.md for the full research and
#   live-verification writeup (all 4 phases done 2026-07-16).
```

**LLM provider (pick one, default is the AI Gateway):**
```
LLM_PROVIDER=gateway         # or "groq"
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
```

**Optional:**
```
WEBHOOK_URL=                          # default n8n/Zapier/Make webhook target
NUMBER_CONFIG=                        # JSON per-number config, see docs/reference/configuration.md
WORKFLOWS=                            # JSON workflow configs, see docs/workflows.md
AGENT_PERSONAS=                       # JSON per-number persona overrides
HUBSPOT_API_KEY=                      # for the crmSync tool
RECORDING_DISCLOSURE_ENABLED=true     # spoken consent/AI disclosure at call start (default ON)
RECORDING_DISCLOSURE_TEXT=            # override the default disclosure wording
DATA_RETENTION_DAYS=90                # GDPR: auto-purge call data older than this
COMPLIANCE_MODE=                      # set to "hipaa" to enable the HIPAA boot guardrail
HIPAA_BAA_CONFIRMED=                  # must be "true" if COMPLIANCE_MODE=hipaa — see docs/reference/compliance.md
HIPAA_RETENTION_DAYS=30               # shorter retention window used automatically in HIPAA mode
ADMIN_API_KEY=                        # protects ops endpoints — see docs/reference/security.md. Strongly recommended.
OUTBOUND_CALL_RATE_LIMIT=30           # max outbound calls per window (default 30)
OUTBOUND_CALL_RATE_WINDOW_MS=60000    # rate-limit window in ms (default 1 minute)
```

## Point Twilio at your app

In the Twilio Console, set your phone number's **"A call comes in"** webhook to:

```
POST  {PUBLIC_APP_URL}/api/voice/incoming
```

## Trigger an outbound call

```bash
curl -X POST {PUBLIC_APP_URL}/api/voice/calls/outbound \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15559876543",
    "persona": "You are a friendly scheduling assistant.",
    "webhookUrl": "https://your-n8n-instance/webhook/abc123"
  }'
```
Every outbound call automatically passes a Do-Not-Call check and a TCPA calling-window check before
dialing — a blocked call returns a `403` with the reason, and never reaches Twilio.

## Next steps

- [`architecture/README.md`](../architecture/README.md) — how a call flows through the system, repo layout, plus diagrams (`architecture/voice-orchestration.md`, `api-flow.md`, `user-flow.md`, `data-model.md`)
- [`docs/reference/api-reference.md`](./api-reference.md) — every endpoint
- [`docs/reference/compliance.md`](./compliance.md) — TCPA/DNC/HIPAA/GDPR, what's enforced automatically
- [`docs/reference/security.md`](./security.md) — admin auth, webhook signature validation, rate limiting, tunneling
- [`docs/reference/configuration.md`](./configuration.md) — per-number config, personas, workflows
- The in-app `/docs` page (running server) mirrors this for anyone browsing the live app directly
