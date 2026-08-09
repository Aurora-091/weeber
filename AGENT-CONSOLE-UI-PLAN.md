# AGENT-CONSOLE-UI-PLAN.md — Agent config + live preview upgrade

> **Status: Phase 1 and Phase 2 shipped 2026-07-12** (commits `03b3d40`, `8001d9d`). See
> `docs/changelog/2026-07.md`'s two "Agent Preview drawer" entries and `docs/decisions/` ADR-051 for what actually
> got built vs. this plan. Phase 3 remains deliberately not started — see §3 below for why.

**Reference:** two ElevenLabs Conversational AI screenshots (agent config editor with a right-side
property rail; a separate live "Preview" experience — animated voice orb, phone-call button, text-chat
fallback, Inline/Widget toggle, Mock tools toggle). Confirmed scope from the requesting round:

- **Both surfaces get this**: `/app/agents` (merchant) and `/dashboard/agents` (admin) — admin's
  `AgentTestChat` today is text-only, no voice at all.
- **Full in-browser voice test call**, not a text-chat restyle — real mic in, real agent voice out,
  no phone number involved.
- **Entry point confirmed**: a "Preview" button, top-right corner of the agent page. Clicking it opens
  a right-side panel/drawer containing the live preview (orb animation, call controls). Not a permanent
  two-pane layout — the config form stays exactly as it is today; the drawer is an overlay.

---

## 1. What exists today (the actual starting point, not assumed)

- `pages/app/agents.tsx` / `pages/dashboard/agents.tsx` — single-column accordion form. Identity, tone,
  voice/language, LLM, tools, guardrails. Shared schema (`voice/agent-frame.ts`), same API shape,
  merchant re-scoped to own org (no org picker).
- **Voice preview today**: a "Hear it" button → `POST /api/app/voice-preview` (rate-limited,
  `previewRateLimited`) → generates one WAV of a *fixed sentence* via the selected TTS provider/voice →
  plays in a plain `<audio>` element. One-shot, no conversation, no mic.
- **Test chat today**: `AgentTestChat` component, **admin-only** (`/dashboard/agents`), backed by a real
  `POST /api/voice/orgs/:orgId/agent-configs/:templateKey/test-chat` endpoint, rate-limited
  (`testChatRateLimited`). Text-only — no voice, no orb, not exposed to merchants at all.
- **Telephony transport is already provider-abstracted**: `voice/stream.ts`'s
  `createVoiceStreamHandlers(provider)` takes `"twilio" | "plivo" | "exotel"`, and `ws-route.ts` maps
  each to its own WebSocket path (`/api/voice/stream`, `/stream/plivo`, `/stream/exotel`). This is the
  single most important existing piece of leverage for Phase 2 below — a 4th `"browser"` provider slots
  into a pattern that already exists, instead of inventing transport abstraction from scratch.

## 2. What we're building

**One shared component**, used identically on both surfaces (matches the existing pattern of one
`agent-frame.ts` schema powering both pages):

- `components/agent-preview/PreviewButton.tsx` — top-right corner button, label "Preview", opens the drawer.
- `components/agent-preview/PreviewDrawer.tsx` — right-side sheet (shadcn `Sheet`, already in the
  component set per `UI-DESIGN-BRIEF.md`'s "modals/popovers get elevation shadow" rule — this is exactly
  that kind of surface). Contains:
  - `VoiceOrb.tsx` — animated orb, idle/listening/speaking/thinking states.
  - Call controls: **Start call** / **End call**, mute toggle, elapsed-time readout.
  - A **Text** tab as fallback/no-mic path — this is where the *existing* `AgentTestChat` component gets
    reused (restyled to sit inside the drawer, and — new — exposed on the merchant surface for the first
    time, not just admin).
  - Uses the *current, unsaved* form state from the page behind it (persona prompt, voice, tone, tools
    the merchant/admin is actively editing) — same live-preview expectation ElevenLabs sets: you're
    previewing what you're about to save, not what's already saved.

**The orb** — no reason to reach for a 3D/WebGL library. CSS-only: a radial-gradient circle,
`transform: scale()` + `opacity` pulsing via a Web Audio `AnalyserNode` reading either the mic input level
(listening state) or the TTS playback buffer's level (speaking state) — same technique most voice-agent
demos use. One `useAudioLevel(sourceNode)` hook, two orb states driven by whichever level is currently
live.

---

## 3. Phasing (biggest lift is real, sizing it honestly)

### Phase 1 — Text tab + orb shell (ships fast, de-risks the drawer/layout work first) ✅ SHIPPED
- Build `PreviewButton` + `PreviewDrawer` shell, Text tab wired to the *existing* test-chat endpoint
  (already real, already rate-limited) — **new work here is just exposing it on the merchant surface**
  (currently admin-only) and restyling it to sit in the drawer instead of inline in the page.
- Orb exists visually but only reacts to **TTS playback** (i.e., wire it to the existing one-shot
  `/voice-preview` WAV endpoint's audio element) — gives the "it feels alive" visual immediately without
  touching telephony transport at all.
- Ships value on its own: merchants get a real conversation test for the first time (today they only get
  "hear one sentence" or nothing). Low backend risk — no new transport, no new billing-shaped surface.

### Phase 2 — Real full-duplex voice test call (the actual "biggest lift" piece) ✅ SHIPPED
This needs a new, browser-native call transport — mic in, agent voice out, no telephony vendor:
- **Backend**: add a 4th provider to the existing abstraction — `createVoiceStreamHandlers("browser")`,
  mounted at e.g. `/api/voice/stream/browser`. Framing differs from Twilio/Plivo/Exotel (no vendor
  envelope — raw Opus/PCM chunks over the WebSocket, encoded/decoded with the Web Audio API on the
  client) but it feeds the **same** STT → LLM → TTS → agent-frame pipeline every real call already uses —
  this is the part that makes the preview trustworthy: it's not a simulation, it's the real pipeline with
  a browser tab standing in for a phone.
- **Auth/scoping**: this WS needs the merchant/admin session (not a phone call's Twilio signature check)
  — reuse `requireMerchantSession`/`requireAdminKey`'s pattern for the WS upgrade handshake.
- **Rate limiting**: real STT/LLM/TTS cost per test call, same "can't be unmetered" principle already
  documented for `previewRateLimited`/`testChatRateLimited` in `routes.ts` — add a `testCallRateLimited`
  fixed-window limiter, same shape, probably tighter (full calls cost more than one TTS sentence).
- **Frontend**: `useVoiceTestCall()` hook — mic permission request, `getUserMedia`, encode+stream to the
  WS, decode+play incoming agent audio, drive `VoiceOrb`'s listening/speaking state off both directions'
  audio levels via the same `useAudioLevel` hook from Phase 1.
- **Honest risk callouts**: mic-permission UX (denied/blocked states need a clear fallback message, not a
  silent failure), latency expectations (STT→LLM→TTS round-trip over a WS from a browser tab won't be
  identical to a Twilio media stream — should feel comparable, not necessarily faster or equally low-jitter),
  and this is real infra work (new WS route + codec handling), not a frontend-only task — size it as a
  backend-plus-frontend unit, not a UI sprint.

### Phase 3 — Parity polish (once Phase 2 is proven)
- Same drawer ships on **both** surfaces from Phase 1 already (shared component) — Phase 3 is about the
  smaller ElevenLabs affordances worth copying *if* they earn their keep: a "Mock tools" toggle (test
  without actually firing `bookAppointment`/`crmSync` against real systems), an inline vs. floating-widget
  toggle (lower priority — you don't have a public embeddable widget product surface today, so this may
  not apply at all unless that's coming).
- Variable/merge-tag preview (a "Vars" button, screenshot 2) — only relevant once the workflow-canvas
  variable system (`docs/workflow-canvas/architecture.md` §4) actually exists; until then there's nothing
  to inject besides the fixed preview sentence already in use. Don't build this ahead of that.

---

## 4. What we are explicitly NOT doing

- Not rebuilding the page layout into ElevenLabs' permanent two-pane editor — confirmed: the config form
  stays as-is, Preview is a drawer trigger, not a layout change.
- Not building a 3D/canvas-library orb — CSS + Web Audio levels is enough and keeps bundle size down
  (already flagged once this session that the JS bundle is over Vite's 500kb chunk-size warning).
- Not building the "Vars"/merge-tag injection until the workflow-canvas variable system exists — sequencing
  it before that would mean building UI for data that doesn't exist yet.

## 5. Suggested build order

1. Phase 1 (Text tab + TTS-reactive orb) — both surfaces, reusing existing endpoints. Fastest path to a
   visibly better agent page.
2. Phase 2 backend (browser WS provider + rate limiter) — can start in parallel with #1's frontend work
   once #1's drawer shell exists to plug into.
3. Phase 2 frontend (`useVoiceTestCall`, mic UX, full orb reactivity).
4. Phase 3 — only the pieces that still make sense once workflow-canvas and/or a public widget surface
   actually exist.
