# Research + Plan: Workflow Canvas v2 (ElevenLabs-informed) + Multi-Voice Feature Gap

**Date**: 2026-07-15. **Status**: research + proposed plan, nothing built yet — same "needs a design
decision, don't silently default" discipline as `audit/2026-07-15-audit-05.md`, which this doc directly
follows up on. Grounded in: (1) ElevenLabs Agents' public docs on Workflows and the Prompting Guide
(user-provided reference material, 2026-07-15), (2) this repo's actual current code
(`components/canvas/*`, `voice/workflows/graph-engine.ts`, `voice/workflows/admin-routes.ts`,
`voice/tts/{cartesia,elevenlabs}.ts`), (3) `docs/workflow-canvas-architecture.md` (the original spec
this was built from) and `audit/2026-07-15-audit-05.md` (the gaps this plan addresses).

---

## Part 1 — Workflow Canvas v2

### 1.1 What ElevenLabs actually does (research summary, not aspirational)

Read directly from ElevenLabs' own docs, not inferred:

- **Nodes**: `start`, `override_agent` ("subagent" — overrides prompt/LLM/voice/knowledge-base/tools
  *for that node only*, on top of or instead of the base agent config), a dedicated **tool node**
  (guarantees a specific tool call happens, with distinct **success** and **failure** result edges —
  not the same mechanism as a general branch), **agent transfer**, **transfer to number**, **end**.
- **Edges** carry one of three condition types: **LLM condition** (natural-language string the model
  evaluates at runtime, e.g. *"The support request has been resolved"*), **Expression** (deterministic,
  variable-based), or **unconditional** ("None"). Backward edges are explicitly supported for retry/
  loop-back flows.
- The whole graph is plain JSON (`conversation_config.workflow.{nodes,edges}`), so it round-trips
  through a CLI (`elevenlabs agents pull/push`) for version control, not just the dashboard.
- **Analytics** overlays real usage directly on the graph itself — per-node entry counts, average
  time-in-node, termination counts, and edge-traversal distribution — with a one-click jump from a
  node to the matching conversations in history.
- The **Prompting Guide** (separate doc, same source) is mostly about single-agent prompt structure
  (`# Personality` / `# Goal` / `# Guardrails` sections, tool-parameter format examples, explicit
  tool-failure recovery instructions, an orchestrator/specialist multi-agent pattern) — relevant here
  specifically for how *tool descriptions and error handling* should read, which maps onto Weeber's
  existing `voice/tools/*.ts` definitions and the graph's `call`/`webhook` node config.

### 1.2 Where Weeber already has an equivalent, and where it genuinely doesn't

| ElevenLabs concept | Weeber's current equivalent | Gap |
|---|---|---|
| `override_agent` (subagent) node — override prompt/LLM/voice/KB/tools per node | **Partially** — `CallConfig` on Weeber's `call` node already carries `persona`, discount config, `maxDurationSeconds`; `voice/agent-frame.ts` supports per-agent overrides generally | No per-*node* LLM/voice/KB/tools override — a `call` node always uses the org's one configured agent's model/voice/tools, never a node-specific swap. Real gap if a future workflow ever wants e.g. a stricter/more-guarded model for a payment-confirmation node specifically. |
| Dedicated **tool node** with success/failure edges | **No equivalent** — Weeber's tools run *inside* an agent turn (any tool call is available to the LLM every turn per `voice/agent.ts`'s `buildVoiceTools`), not as a graph node with its own routing | Real gap, but lower priority — Weeber's graph nodes (`call`, `sms`, `webhook`, `addToDnc`) already *are* effectively guaranteed-execution action nodes; the missing piece is specifically "if the webhook node's call fails, route here" vs. today's implicit fall-through. Cheapest fix: add a `failureEdgeTarget` concept to the existing `webhook`/`call` nodes rather than inventing a new node type. |
| **LLM condition** edges (natural-language, evaluated at runtime) | **No equivalent** — Weeber's only branching node, `conditionalSplit`, routes on a **fixed enum** (`WORKFLOW_OUTCOMES`: answered/no-answer/busy/failed/voicemail/interested/not-interested/callback-requested/booked/no-decision/wrong-number/default), set by `voice/tools/setDisposition.ts` at the end of a call | This is Weeber's biggest structural gap vs. ElevenLabs' model. Fixed-enum branching is more predictable/auditable (a real strength for a compliance-conscious product — don't lose this), but can't express something like *"branch here if the caller mentioned a competitor's name"* without a code change to add a new enum value + a new `setDisposition` category. Worth a genuine design decision (§1.4), not an assumed yes. |
| **Expression** edges (deterministic, on structured data) | **Yes, already this** — `conditionalSplit`'s enum-based routing *is* Weeber's expression-edge equivalent, just less general (fixed dispositions, not arbitrary variable comparisons over `context`) | Minor — could be generalized to arbitrary `context` key comparisons (e.g. `context.cart_value > 100`) without adopting LLM-conditions at all. Cheaper, lower-risk upgrade than LLM conditions; see §1.4. |
| Graph-overlay **analytics** (per-node entries/duration/terminations) | **No equivalent** — `workflow_runs` table exists and is queryable, but nothing renders it back onto the canvas | Real, valuable, currently-missing feature — directly actionable, no architecture risk (pure read/aggregation, same pattern as this session's `turn_latency` P50/P90 work). |
| JSON push/pull via CLI for version control | **N/A / not needed yet** — Weeber's graphs are DB rows (`workflow_templates.graph` jsonb), editable only via the admin UI or direct API | Low priority. Worth revisiting only if/when there's a real multi-environment (staging/prod template promotion) workflow need. |

### 1.3 Direct fixes to audit #05's findings (do these first, regardless of any v2 decision below)

These are prerequisites, not part of the "should we adopt X" discussion — audit #05 already found them
as real, reproducible bugs, independent of anything ElevenLabs does differently:

1. **Escalating-discount `-Infinity` key bug** (`NodeConfigPanel.tsx`'s `EscalatingMap`) — fix
   `addEntry()`'s `Math.max(...Object.keys(map).map(Number))` to fall back to `0` when the map is
   empty, and/or stop `removeEntry()` from allowing the last entry to be deleted.
2. **`delayMinutes` has no server-side clamp** — add the equivalent of `clampDiscount()` for wait-node
   delay, mirroring the pattern that already protects `discountPercent`.
3. **"Load example" silently overwrites unsaved work** — gate it behind `if (dirty && !confirm(...))
   return;`, and fix its icon (`Download` currently implies the opposite of what it does).
4. **Workflow Canvas node creation is mouse-only** (`NodePalette.tsx`'s `draggable`/`onDragStart` only,
   no `onClick` fallback) — add a keyboard/click path to add a node, even a simple "click a palette
   entry to add it at a default position" as a first pass rather than solving full drag-and-drop
   accessibility in one go.
5. **Single-agent orgs don't get the agent-switcher pill** (ADR-055 vs. actual `agents.tsx` behavior
   mismatch) — either always render it (matching the ADR's stated intent) or correct the ADR.

None of these require the ElevenLabs-informed decisions below — they're bugs in what's already built.

### 1.4 The real decision: how far to move toward ElevenLabs' model

Three concrete options, not a recommendation picked for you:

**Option A — Stay fixed-enum, add analytics overlay only.**
Lowest risk, highest immediate value-per-effort. Build the per-node entry/duration/termination overlay
(§1.2's analytics gap) against the existing `workflow_runs` table — this is pure read-side work, same
shape as this week's `turn_latency` dashboard addition, no changes to the graph model or execution
engine. Ship this regardless of what else gets decided; it's useful either way.

**Option B — Generalize `conditionalSplit` to expression edges over `context`, stay away from LLM
conditions.**
Medium effort. Instead of routing only on the fixed `WORKFLOW_OUTCOMES` enum, let a `conditionalSplit`
edge's condition be a small, safe expression over `context` (e.g. `cart_value > 100`,
`attempt_number >= 2`) — parsed and evaluated server-side in `graph-engine.ts` with a tiny, deliberately
non-Turing-complete expression grammar (comparison operators + AND/OR only, no arbitrary code eval —
this matters for a compliance-conscious product, don't build a `new Function()` sandbox). Keeps
branching **deterministic and auditable** (a real strength worth preserving, called out explicitly in
§1.2), while closing the gap where a merchant wants to branch on something numeric/structural that
isn't one of the fixed dispositions. This is ElevenLabs' "Expression" edge type, not their "LLM
condition" type — deliberately the safer half of their model to adopt.

**Option C — Adopt LLM-condition edges too.**
Highest effort, highest risk, most capability. Requires: a new edge-condition type in
`components/canvas/types.ts`, a runtime LLM call in `graph-engine.ts` to evaluate the condition string
against the current transcript/context at branch time (latency + cost per branch — needs its own
budget, likely fine since branching happens post-call, not mid-conversation), and — most
importantly — a **compliance review**, since this product's whole audit trail today
(`openvent-compliance`'s `buildCallAuditRecord`) assumes deterministic, enum-based dispositions. An
LLM-evaluated branch condition means "why did this call go down this path" now has a probabilistic
answer, not a fixed one — worth being explicit that this is a real product-philosophy tradeoff, not
just an engineering cost, before picking this option.

**Recommendation for discussion, not a decision made here**: A, then B if there's a concrete merchant
ask for it. C only if a specific, named use case shows up that A/B genuinely can't express — the
enum-based approach is a real advantage for this product's compliance story, and ElevenLabs doesn't
have the same TCPA/DNC/audit-trail obligations baked into their core pitch that Weeber does.

### 1.5 Tool-node-with-failure-routing (§1.2's other real gap) — smaller, standalone fix

Doesn't need to wait on §1.4's bigger decision. Add an optional `onFailureNodeId` field to `webhook`
and `call` node configs (`components/canvas/types.ts`'s `WebhookConfig`/`CallConfig`); in
`graph-engine.ts`, if the webhook dispatch fails (non-2xx, timeout, network error) and
`onFailureNodeId` is set, route there instead of falling through to whatever the default outgoing edge
was. Small, additive, no new node type, no new edge-condition machinery — directly closes the
"dispatchWebhook has no outbox/retry, so a merchant should at least be able to branch on failure"
gap noted in `audit/2026-07-15-audit-06-db-systems.md` §8.

---

## Part 2 — Multi-voice / character switching: feature-gap research

### 2.1 What ElevenLabs actually does (research summary)

- Per-agent config lists `supported_voices`: each entry has a **label** (the tag name the LLM uses,
  e.g. `"Spanish"`, `"Narrator"`), a **voice ID**, an optional **model family override** (Flash/Turbo/
  Multilingual), an optional **language override**, and a **description** (natural-language guidance
  for *when* the LLM should use it — injected into the system prompt automatically).
- At inference time, the LLM is instructed to wrap voice-switched text in XML-style tags:
  `<Spanish>¡Hola!</Spanish>`. Text outside any tag uses the agent's default voice. **Nested tags are
  explicitly not supported.**
- This is fundamentally a **prompt-engineering + TTS-request-routing** feature, not a new conversation-
  architecture concept — the LLM just emits marked-up text, and the platform's TTS layer parses the
  markup and requests the right voice per segment.

### 2.2 Why this doesn't fit Weeber's current TTS architecture without real engineering work

Checked directly, not assumed: **every TTS provider Weeber has today opens one connection with one
fixed voice for the entire turn.**

- `voice/tts/cartesia.ts`: `connectCartesiaTts` opens a single WebSocket, with `voiceIdOverride`
  resolved once at connect time; all of a turn's text streams into that one connection's one
  `context_id`.
- `voice/tts/elevenlabs.ts`: same shape — `voiceIdOverride` resolved once, baked into the WebSocket URL
  itself (`.../text-to-speech/${voiceId}/stream-input`).
- `voice/stream.ts`'s `speak()` — the shared turn-runner every agent response goes through — creates
  **one** `tts` connection per turn and feeds it LLM text deltas via `tts.sendText(delta)` as they
  arrive. There is no per-segment voice-switching anywhere in this pipeline today.

Supporting real mid-turn voice switching means one of:
1. **Reconnect mid-turn** — close the current TTS connection and open a new one each time a voice tag
   changes, mid-stream, while a turn is still being generated. Each reconnect costs real time
   (WebSocket handshake + provider connection setup) — directly working against everything this
   session's `turn_latency`/`bench:latency` work was built to measure and protect. Naively, every voice
   switch mid-sentence would add a visible latency stutter.
2. **Pre-open a connection per configured voice** — hold N simultaneous TTS WebSocket connections open
   for the duration of a turn (one per `supportedVoices` entry that might get used), and route each
   text segment to the right already-open connection. Avoids the reconnect-latency cost, but multiplies
   concurrent provider connections (and likely cost, depending on provider billing model — worth
   checking Cartesia/ElevenLabs pricing before committing to this) by however many voices are
   configured, for every single call, whether or not that call ever actually uses more than one voice.
3. **Segment-then-sequence** (the pragmatic middle ground): don't try to stream-and-switch inside a
   single continuous turn at all. Parse the LLM's full response for voice tags *after* generation
   completes (not mid-stream), split it into ordered segments, and play each segment's TTS output
   sequentially — accepting a small end-to-end latency hit (waiting for the full response before any
   audio starts, instead of today's stream-as-you-go) only on turns that actually contain a voice
   switch. Turns with no voice tags keep today's fully-streamed, low-latency path unchanged.

None of these are what Weeber's architecture does today, and options 1 and 2 both cut directly against
the latency work this session already did (the whole point of `turn_latency`/filler-audio/adaptive
noise gating was shaving milliseconds off time-to-first-audio-byte). Option 3 is the only one that
doesn't regress the common case, at the cost of only supporting per-segment switching, not true
interruption-mid-syllable character banter.

### 2.3 Does Weeber actually need this? (the question to answer before scoping any build)

Unlike the Workflow Canvas gaps (real merchants are already hitting the "-Infinity bug" and validation
gaps today, in a feature that ships), **multi-voice has no identified Weeber use case yet.**
ElevenLabs' own stated use cases — multi-character storytelling, language tutoring with native-accent
voices per language, role-playing — don't map cleanly onto Weeber's current verticals:

- **Shopify** (cart recovery, order status): single agent voice throughout is the norm for every real
  competitor in this space (Bolna, Vapi, Retell) — no evidence any of them ship multi-voice for
  commerce use cases either.
- **Clinic/insurance** (booking, reminders): same — a single, consistent, trustworthy voice is likely
  *more* appropriate for these verticals, not less (a healthcare reminder call switching character
  voices would read as confusing or gimmicky, not delightful).
- The one plausible fit — language-tutoring-style native-accent switching for genuinely bilingual/
  code-switching calls (relevant given Weeber's existing Hindi/Marathi/Tamil language support work,
  `WEEBER-PLAN.md`'s Phase B2 "dual-language-in-one-call" item) — is a **real, closer-to-home
  candidate** than character voices, and worth checking whether B2 already covers this need without
  multi-voice's markup/tagging machinery at all (a bilingual agent might just need *one* consistent
  voice that speaks two languages well, not a voice switch).

**Recommendation**: don't scope a build yet. This is correctly flagged as "worth a note for a future
feature-gap audit," not "build this." Before any engineering investment: (1) check whether Phase B2's
dual-language work already solves the actual underlying need without voice-switching markup, (2)
confirm with an actual prospect/pilot conversation whether anyone has asked for character-style voice
switching specifically, since none of the three current verticals obviously need it. If a real need
surfaces, Option 3 (§2.2) is the lowest-risk starting point — it doesn't touch the hot streaming path
for the common (no-switch) case at all.

---

## Summary / next actions

- **Do now, independent of any decision above**: the five audit #05 bug fixes in §1.3 — these are
  bugs, not design questions.
- **Cheap, high-value, no open design question**: build the workflow-analytics graph overlay (§1.4
  Option A) and the webhook/call failure-routing field (§1.5) — both additive, both directly answer
  gaps already found in this audit series.
- **Needs a real decision before building**: whether to generalize `conditionalSplit` to expression
  edges (§1.4 Option B) and whether LLM-condition edges are ever appropriate given this product's
  compliance posture (§1.4 Option C, leaning no unless a concrete case appears).
- **Don't build yet**: multi-voice (§2) — no identified need in any current vertical, and the two
  architecturally-obvious ways to build it both regress this session's latency work. Revisit only if
  Phase B2 doesn't already cover the actual underlying (bilingual, not multi-character) need, or a
  real prospect asks for it specifically.
