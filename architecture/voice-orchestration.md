# Voice Orchestration — the call pipeline

How one call actually flows through the system, file by file. See `README.md` for the repo layout
these files live in.

## End-to-end pipeline

```mermaid
sequenceDiagram
    participant Caller
    participant Tel as Telephony provider<br/>(Twilio / Plivo / Exotel)
    participant WS as voice/stream.ts<br/>(per-call WS state machine)
    participant STT as voice/stt/*.ts<br/>(Deepgram nova-3 / Sarvam Saaras)
    participant Agent as voice/agent.ts<br/>(runVoiceAgentTurn)
    participant LLM as voice/llm/*.ts<br/>(AI Gateway / Groq)
    participant TTS as voice/tts/*.ts<br/>(ElevenLabs / Cartesia / Sarvam Bulbul)
    participant Tools as voice/tools/*.ts

    Caller->>Tel: dials in, or provider dials out
    Tel->>WS: Media Stream connects (bidirectional WS,<br/>base64 mu-law 8kHz frames)
    WS->>Agent: runVoiceAgentGreeting()
    Agent->>TTS: synthesize greeting
    TTS->>WS: audio chunks
    WS->>Tel: playback to caller

    loop every caller utterance
        Caller->>Tel: speaks
        Tel->>WS: audio frames
        WS->>STT: forward frames
        STT-->>WS: interim transcript (not final)
        STT->>WS: final transcript (speech_final)
        WS->>Agent: runVoiceAgentTurn(transcript)
        Agent->>Agent: buildKnownFactsBlock() + buildCallerMemoryBlock()<br/>(structured, deterministic — not RAG, see note below)
        Agent->>LLM: streamed completion, tool-calling enabled
        alt LLM calls a tool
            LLM->>Tools: e.g. offerCartRecoveryDiscount / confirmCodOrder / transferToHuman
            Tools-->>LLM: tool result
        end
        LLM-->>Agent: streamed text tokens
        Agent->>TTS: synthesize (mulaw/8000, no re-encode)
        TTS-->>WS: streamed audio chunks
        WS->>Tel: playback to caller
        opt barge-in
            Caller->>Tel: interrupts mid-playback
            Tel->>WS: new speech detected
            WS->>Tel: send "clear" event
            WS->>WS: abort in-flight LLM/TTS
        end
    end

    Caller->>Tel: hangs up / call ends
    WS->>Agent: capture disposition (if any)
    WS->>WorkflowEngine: call status + disposition
```

**Note on memory:** the "known facts" / "caller memory" blocks injected into the LLM prompt
(`buildKnownFactsBlock`, `buildCallerMemoryBlock` in `voice/agent.ts`, backed by `voice/caller-memory.ts`)
are a **structured, deterministic** memory system — not a RAG/vector-search layer. This solves a
different problem than a knowledge base (see `docs/state-engine.md` for why raw-transcript/lossy-summary
memory causes agents to re-ask or contradict themselves). **Separately, a real per-vertical PDF-upload
knowledge base is referenced by the persona prompts (`docs/agent-prompts/01`, `04`) but does not exist in
the schema/backend yet** — see `WEEBER-PLAN.md`'s Phase A tracking for this gap.

## Telephony provider abstraction

```mermaid
flowchart LR
    Routes["voice/routes.ts<br/>/api/voice/*"] --> Transport["voice/telephony-transport.ts<br/>wire-format abstraction"]
    Transport --> TwilioClient["twilio-client.ts"]
    Transport --> PlivoClient["plivo-client.ts"]
    Transport --> ExotelClient["exotel-client.ts"]
    TwilioClient --> TwilioProv["twilio-provisioning.ts<br/>(sub-accounts, numbers)"]
    PlivoClient --> PlivoProv["plivo-provisioning.ts"]
    ExotelClient --> ExotelProv["exotel-provisioning.ts"]
    TwilioProv --> OrgsTable[("orgs.twilioMode<br/>platform | own sub-account")]
```

One org can be on Twilio (global default) or Plivo/Exotel (India-first alternative) — the abstraction
means `voice/routes.ts` and `voice/stream.ts` never branch on provider directly.

## STT/TTS provider selection today

Per-agent config (`agentTemplates`/`orgAgentConfigs`) lets an operator pick `sttProvider` (`deepgram` |
`sarvam`) and `voiceProvider` (`elevenlabs` | `cartesia` | `sarvam`) — **but this is one static field per
agent, not a per-call, per-language switch.** Building the actual dual-language-in-one-call behavior
(detect language mid-call, switch TTS voice, debounce noisy short-utterance detections) is tracked as
**Phase B2** in `WEEBER-PLAN.md` — the provider adapters (`stt/sarvam.ts`, `tts/sarvam.ts`) already exist,
the orchestration logic to actually switch languages inside one call does not yet.
