# Architecture

> Moved from `docs/architecture.md` (2026-07-13) into this folder, which also holds the diagram docs
> (`voice-orchestration.md`, `api-flow.md`, `user-flow.md`, `data-model.md`). Rewritten against the
> current codebase — the previous version referenced a pre-Postgres, pre-package-split layout that no
> longer exists.

How a call actually flows through Weeber/openvent, end to end, and how the repo is laid out.

## Where openvent sits: self-hosted orchestration, bring-your-own AI providers

Voice-agent architectures sit on a spectrum:

```
Fully local                    openvent                       Fully managed
(Ollama + local STT/TTS,       (orchestration self-       (Vapi, Retell, LiveKit
zero cloud, real GPU/          hosted; LLM/STT/TTS/       Cloud — zero infra,
latency/quality tradeoffs)     PSTN are cloud APIs         zero control, no
                                you own the wiring for)     provider choice)
```

openvent self-hosts the *orchestration layer* — the code, the database, the call logic, the compliance
rules, the dashboards, all inspectable and yours. The *AI layer* (LLM inference, STT, TTS) and the
*telephony layer* (PSTN) remain cloud APIs by necessity — see `DECISIONS.md` ADR-016 for the full
reasoning on why "fully local" is a legitimate but different product, not a near-term goal here.

What you actually own at this position: which provider plugs into each slot (swap Deepgram ↔ Sarvam ↔
ElevenLabs, swap Twilio ↔ Plivo ↔ Exotel, swap ElevenLabs ↔ Cartesia ↔ Sarvam — no migration, no
platform lock-in),
where the call data lands (your own Postgres, not a platform's dashboard), and every line of call logic
and compliance enforcement. What you don't own: the phone network itself, or the model weights the
LLM/STT/TTS calls run against.

## Repo layout (current, 2026-07-13)

```
packages/
├── api/                          # @weeber/api — Bun + Hono backend, deployed to Railway
│   └── src/
│       ├── database/              # Drizzle schema (Postgres/Supabase) + migrations
│       ├── app/                   # user-facing (/api/app/*) + admin (/api/dashboard/*) HTTP routes
│       │   ├── routes.ts          # userApp — /api/app/* (agent config, settings, workflows, me)
│       │   ├── public-routes.ts   # zero-auth routes (waitlist, support submission)
│       │   └── middleware/        # supabase-auth.ts (JWT/JWKS), requireUserOrg
│       ├── integrations/
│       │   └── shopify/           # routes.ts — the weebersh webhook contract (9 receivers)
│       └── voice/                 # everything call-related — see voice-orchestration.md
│           ├── routes.ts          # main /api/voice/* surface — start here
│           ├── stream.ts          # per-call WebSocket state machine (the pipeline below)
│           ├── agent.ts           # LLM turn runner + persona + known-facts prompt injection
│           ├── turn-detection/    # pluggable end-of-turn (EOT) seam — heuristic default, model deferred (Five Bets P5)
│           ├── backchannel.ts     # cached low-latency mid-utterance acks (Five Bets P4)
│           ├── call-health.ts     # per-call health classifier — feeds the P5 model-wiring gate (Five Bets P2)
│           ├── guardrail-events.ts# guardrail_events audit table writer (Five Bets P1)
│           ├── synthetic-scenarios.ts # offline agent-behavior scenario harness (Five Bets P3)
│           ├── stt/               # deepgram.ts, sarvam.ts, elevenlabs.ts — STT provider abstraction
│           ├── tts/               # elevenlabs.ts, cartesia.ts, sarvam.ts — TTS provider abstraction
│           ├── llm/               # AI Gateway / Groq provider abstraction
│           ├── telephony-transport.ts   # Twilio/Plivo/Exotel wire-format abstraction
│           ├── {twilio,plivo,exotel}-client.ts        # per-provider call control
│           ├── {twilio,plivo,exotel}-provisioning.ts  # per-org sub-account/number provisioning
│           ├── tools/             # agent tool-calling (offerCartRecoveryDiscount, confirmCodOrder, etc.)
│           ├── workflows/         # outcome-based automation + scheduler.ts (60s sweep)
│           ├── compliance/        # adapters wiring @openvent/compliance into this app
│           └── integrations/      # HubSpot/Salesforce/GoHighLevel/Google Calendar CRM adapters
├── openvent-compliance/          # @openvent/compliance — standalone, framework-agnostic
│                                  # (DNC, calling-window/TCPA, GDPR erasure, audit trail).
│                                  # Zero dependency on Twilio/Bun/Hono/any specific DB.
├── web/                          # @weeber/web — React/Vite frontend, deployed to Vercel
│   └── src/web/
│       ├── pages/
│       │   ├── app/               # merchant-facing /app/* pages
│       │   └── dashboard/         # admin-facing /dashboard/* pages
│       └── components/
│           ├── shell/             # AppShell (shared layout for both apps)
│           ├── app/               # UserShell, setup-modal.tsx (onboarding)
│           ├── dashboard/          # DashboardShell
│           ├── canvas/             # Workflow Canvas (React Flow) node/edge components
│           └── agent-preview/      # PreviewDrawer/PreviewButton — live voice test call
├── mobile/                       # Expo app shell (not voice-specific yet)
└── desktop/                      # Electron shell (not voice-specific yet)

architecture/    # you are here — diagrams + this overview
audit/           # dated point-in-time code audits (backend + UI/UX)
docs/            # reference docs (compliance, testing, telephony, agent-prompts, ...)
```

## Pipeline (see `voice-orchestration.md` for the full diagram)

```
Inbound:  Caller -> provider number -> POST /api/voice/incoming (TwiML/XML) -> wss connect
Outbound: POST /api/voice/calls/outbound -> compliance gates -> provider places call -> same stream flow

Media Stream (bidirectional WS, base64 mu-law 8kHz audio frames, Twilio/Plivo/Exotel wire-format
normalized by telephony-transport.ts)
        |  caller audio chunks
        v
STT  (Deepgram nova-3, Sarvam Saaras, or ElevenLabs Scribe v2 Realtime for Indic —
     stt/deepgram.ts / stt/sarvam.ts / stt/elevenlabs.ts, see docs/voice-quality/hindi-hinglish-voice-support.md)
        |  finalized transcript
        v
LLM Agent (AI Gateway or Groq — voice/llm/, streamed, tool-calling, latency telemetry)
        |  streamed text tokens
        v
TTS  (ElevenLabs, Cartesia, or Sarvam Bulbul — voice/tts/*.ts, output_format=mulaw/8000)
        |  streamed audio chunks
        v
Media Stream  ->  caller hears the agent

Barge-in: if the STT detects new speech while the agent is talking, we send a "clear" event to the
telephony provider and abort the in-flight LLM/TTS immediately (voice/stream.ts).

On call end: disposition (if captured) + call status feed the workflow engine (voice/workflows/),
which can automatically schedule a retry, add the number to the DNC list, or fire a webhook (n8n/
Zapier/Make-consumable, voice/webhooks.ts) — no manual step required.
```

## Key design decisions

Every consequential architecture decision — and the reasoning behind it, including ones later reversed
— is recorded in [`DECISIONS.md`](../DECISIONS.md). Worth reading before making a large change; it'll
usually tell you why something is the way it is, or that a given approach was already tried and rejected.

## Operational constraints

**Single-instance requirement.** The backend currently runs as a single Railway instance (`replicas: 1`).
Several in-process components rely on this:

| Component | File | What breaks with >1 instance |
|---|---|---|
| Session store | `voice/session-store.ts` | Live call sessions are in-memory; a second instance can't find sessions from the first |
| TTS audio cache | `voice/tts-cache.ts` | Cache misses double, no correctness issue but increased provider costs/latency |
| Rate limiter | `voice/fixed-window-limiter.ts` | Limits apply per-process, so actual rates are multiplied by instance count |
| Test-call tokens | `voice/test-call-tokens.ts` | Token issued on one instance can't be validated on another |

**If you need horizontal scaling:** set `REDIS_URL` (any Redis-compatible service) — the session store
automatically switches to a Redis-backed implementation (same interface, shared across instances). The
scheduler's CAS claim pattern (`scheduler.ts`) is already safe across multiple instances. See
[`../docs/reference/configuration.md`](../docs/reference/configuration.md) for details.

## Where to go next

- [`voice-orchestration.md`](./voice-orchestration.md) — the call pipeline in detail (mermaid)
- [`api-flow.md`](./api-flow.md) — Shopify webhook → scheduled call → compliance gate → outbound dial
- [`user-flow.md`](./user-flow.md) — signup → onboarding → agent config → live calls, both apps
- [`data-model.md`](./data-model.md) — the full schema as an ER diagram
- [`../WEEBER-PLAN.md`](../WEEBER-PLAN.md) — the phase roadmap, what's built vs. what's next
