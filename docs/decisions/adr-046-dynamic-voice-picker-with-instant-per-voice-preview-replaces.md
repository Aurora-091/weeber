---
adr: 46
title: "Dynamic voice picker with instant per-voice preview (replaces free-text voice ID)"
date: 2026-07-11
status: Accepted
---

## ADR-046 — Dynamic voice picker with instant per-voice preview (replaces free-text voice ID)

**Date:** 2026-07-11

**Context:** The agent-config voice field was a free-text "Voice ID" input plus one global "Preview"
button that generated a fresh paid TTS sample every click. A merchant had to already know a
provider's voice ID by name to use it at all, and browsing options meant repeatedly paying for
generation. Quick competitive check: Retell and Vapi's docs both describe a voice-selection
**dropdown** with an inline, **instant** sample per voice — not a text field, not generate-on-click.

**Decision:** Replaced the text input with a real `VoicePicker` component (searchable dropdown,
per-row play button) backed by each provider's actual voice catalog:
- **ElevenLabs**: `GET /v2/voices` returns a public `preview_url` per voice — embedded directly
  client-side, zero backend involvement, genuinely instant.
- **Cartesia**: `GET /voices?expand[]=preview_file_url` returns `preview_file_url`, but it requires
  the same `Authorization` the API itself needs — the browser can't fetch it directly. Proxied
  through a new `GET /voices/cartesia-preview/:id` route that fetches server-side and streams the
  audio back.
- **Sarvam**: no list-voices or preview API exists at all — a fixed named speaker set per model
  (already known from ADR-040/042's Sarvam integration work). No instant sample is possible; the
  picker falls back to the existing real-generation `/voice-preview` endpoint for this provider only,
  clearly slower and shown as "generating" rather than pretending it's instant.

New `voice/voices-catalog.ts`: `listElevenLabsVoices`/`listCartesiaVoices`/`listSarvamVoices`, each
normalized to `{id, name, description, language, gender, previewUrl}`, with a 10-minute in-memory
cache per provider (voice catalogs don't change often; avoids hitting rate limits on every dashboard
load). Mounted at `GET /api/voice/voices` (admin) and `GET /api/app/voices` (merchant, Supabase
session) — same catalog, two auth surfaces, matching the existing pattern for org-scoped vs.
admin-scoped reads elsewhere in the app.

`VoicePicker` (`components/voice/VoicePicker.tsx`) is shared between `dashboard/agents.tsx` (admin)
and `app/agents.tsx` (merchant) via a `scope: "admin" | "merchant"` prop — same component, correct
auth headers (`adminHeaders()` vs. `appFetch`) resolved internally so neither call site has to know
the difference.

**Consequences:** The old single "Preview with custom text" button/endpoint is unchanged and still
available — instant canned-sample browsing is for picking a voice, custom-text preview is still the
way to test exact agent copy in that voice. No DB schema change — `voiceId` still just stores
whatever ID the picker returns, providers are free-text-compatible as before if a voice isn't in the
fetched list for any reason. Verified: api tsc + 144/144 tests, web tsc + tests + build,
openvent-compliance tsc + 25/25 tests, root lint — all clean.
