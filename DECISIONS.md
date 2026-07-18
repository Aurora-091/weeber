# Architecture Decision Records

This log records consequential technical and product decisions made while building Vent — the *why*
behind the code, not just the *what*. Format: one entry per decision, dated, with context, the decision
itself, and its consequences/tradeoffs. New entries are appended as the project evolves; existing entries
are never rewritten (if a decision is later reversed, add a new entry that supersedes it and says so).

Loosely follows the [Architecture Decision Record](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
pattern popularized by Michael Nygard.

---

## ADR-001 — Self-hosted pipeline over a managed voice-agent platform
**Date:** 2026-07-04

**Context:** Managed platforms (Vapi, Retell, ElevenLabs Agents) offer faster setup for voice agents but
put the operator's prompts, call data, and per-minute cost structure inside someone else's product, with
whatever roadmap and pricing changes that platform decides on.

**Decision:** Build Vent as infrastructure the operator owns end to end — Twilio, Deepgram, the LLM, and
the TTS engine wired directly, with our own database for calls/transcripts, not a third party's dashboard.

**Consequences:** More setup work and more moving pieces to maintain (three-plus vendor integrations
instead of one platform SDK), but full control over cost, data residency, prompt/tool logic, and the
ability to swap any single layer (see ADR-002, ADR-005) without being blocked by a platform's feature
gaps. This tradeoff is explicit in the product's own positioning ("your infrastructure, your rules").

---

## ADR-002 — Cartesia as the default TTS provider, ElevenLabs kept as an option
**Date:** 2026-07-04

**Context:** A real outbound test call went completely silent after connecting. Investigation found
ElevenLabs' free tier returns `402 payment_required` ("Free users cannot use library voices via the API")
for every voice in the account, regardless of which voice ID is configured — this isn't a bug in our code,
it's an ElevenLabs account-tier restriction that can't be worked around without upgrading to a paid plan.

**Decision:** Add Cartesia as a second TTS provider behind a shared `ConnectTts` interface
(`voice/tts/types.ts`), and make it the default (`TTS_PROVIDER=cartesia`) since it works on a free/Starter
plan with no equivalent restriction, and it natively outputs `pcm_mulaw` at 8000Hz — the exact format
Twilio's Media Streams need, with zero re-encoding, matching the same zero-conversion path ElevenLabs
already had.

**Consequences:** ElevenLabs remains fully supported for anyone with a paid plan (`TTS_PROVIDER=elevenlabs`)
— this wasn't a replacement, it was adding optionality the user explicitly asked for ("we will add more
providers"). The provider abstraction this required (rather than a hardcoded ElevenLabs call) is now the
template every future TTS/LLM provider follows.

---

## ADR-003 — Compliance is enforced by default, not left as an integration step
**Date:** 2026-07-04

**Context:** The user explicitly asked for compliance (TCPA, DNC, consent, HIPAA, GDPR) that "runs itself"
— the developer adopting this repo shouldn't have to remember to wire in a DNC check or a recording
disclosure; those are exactly the kind of steps that get skipped under deadline pressure and turn into
real legal exposure once calls are actually placed at volume.

**Decision:** Every outbound call automatically passes through a Do-Not-Call check and a TCPA
calling-window check before dialing (`voice/compliance/`, wired directly into
`POST /calls/outbound`) — a call that fails either check is rejected with a clear reason and never reaches
Twilio. The recording/AI disclosure is spoken at the start of every call by default
(`RECORDING_DISCLOSURE_ENABLED=true` is the default, not opt-in).

**Consequences:** A developer who does nothing beyond setting up API keys still gets baseline TCPA/consent
behavior. The tradeoff is that these checks add a small amount of unavoidable overhead/latency to every
outbound call, and the calling-window timezone inference is best-effort (area-code-based), not perfectly
precise — documented as such rather than presented as legally airtight.

---

## ADR-004 — HIPAA support is a guardrail, not a certification
**Date:** 2026-07-04

**Context:** HIPAA compliance legally requires a signed Business Associate Agreement (BAA) between the
covered entity and every vendor that touches PHI — Twilio, Deepgram, the TTS provider, the LLM provider.
No code running in this repo can verify that a BAA actually exists; that's a contract, not a technical
state.

**Decision:** Rather than silently assume compliance or omit HIPAA support entirely, add a
`COMPLIANCE_MODE=hipaa` flag that makes the server **refuse to boot** unless the operator also sets
`HIPAA_BAA_CONFIRMED=true` — a deliberate human checkpoint. This is documented explicitly, in both the
README and the code comments, as a guardrail against the failure mode of "nobody actually checked," not a
claim that setting the flag makes the deployment HIPAA-compliant.

**Consequences:** This adds friction (a mode that won't start without an extra flag) by design. It does
not, and cannot, replace actually signing BAAs or a real compliance review — that responsibility stays with
the operator. The same honesty principle applies to GDPR: only the concretely codeable pieces (retention
limits, right-to-erasure) are automated; a legal basis for processing is still the operator's
responsibility.

---

## ADR-005 — Groq added as a swappable LLM provider behind the same pattern as TTS
**Date:** 2026-07-04

**Context:** The user asked specifically about using Groq for lower latency/cost. Research confirmed LLM
inference is typically the single largest latency contributor in a voice pipeline (larger than STT or
TTS), and Groq's LPU-based inference is a commonly cited fix for exactly this bottleneck in real-time voice
agents.

**Decision:** Add Groq via the official `@ai-sdk/groq` package as a second LLM provider
(`voice/llm/`), selected via `LLM_PROVIDER=groq`, mirroring the TTS provider-abstraction pattern from
ADR-002 rather than hardcoding a second code path. Added time-to-first-token telemetry per turn so the
latency claim can be measured on real calls instead of assumed.

**Consequences:** The AI Gateway path remains the default (`LLM_PROVIDER=gateway`) since it's what the
platform provisions out of the box; Groq requires the user to supply their own `GROQ_API_KEY`. No
production call has yet been run with Groq active — this decision is recorded, but the latency claim is
not yet empirically verified in this deployment (tracked as an open item).

---

## ADR-006 — Workflows as code-first JSON config, not a visual builder
**Date:** 2026-07-04

**Context:** The user asked for Shopify-flow-style call automation (trigger → branch on outcome → action).
Competitor platforms (Retell, ElevenLabs Agents) increasingly offer visual graph-based workflow builders,
but Vent has no dashboard/UI by explicit earlier product decision.

**Decision:** Define workflows as a JSON array (`WORKFLOWS` env var) mapping call outcomes to actions
(retry/webhook/addToDnc/sendSms-stub), executed by a small engine (`voice/workflows/engine.ts`) and a
background scheduler for delayed retries (`scheduler.ts`).

**Consequences:** No visual editing — changing a workflow means editing an env var and restarting. This
matches the rest of Vent's "edit code/config, not a dashboard" philosophy, but is a real limitation for a
non-technical operator. A visual workflow builder is flagged as a natural v3 direction if the product ever
needs to serve non-developer users directly.

---

## ADR-007 — National DNC Registry integration deferred; internal list is the enforced mechanism today
**Date:** 2026-07-04

**Context:** Research confirmed there is no free public API for the FTC's National Do-Not-Call Registry —
real-time or bulk lookups require a paid Subscription Account Number (SAN) obtained through
telemarketing.donotcall.gov. This is a purchasing decision for the operator, not something the codebase can
resolve unilaterally.

**Decision:** Build and fully enforce an internal DNC list (`voice/compliance/dnc.ts`,
`doNotCall` table) automatically on every outbound call today. Design the check function and schema
(`source: "manual" | "agent" | "national-registry"`) so that syncing the national registry in later is a
pure data-population problem, not a code change — the enforcement path already treats all three sources
identically.

**Consequences:** Out of the box, Vent only blocks numbers the operator has explicitly added (manually, or
automatically via a workflow's `addToDnc` action). It does **not** currently prevent calling numbers
registered on the national registry unless the operator manually adds them — this is a known gap,
documented in the README's "Known limitations," not silently glossed over.

---

## ADR-008 — Public endpoint via a free Cloudflare quick-tunnel is a temporary stopgap, not a solution
**Date:** 2026-07-04

**Context:** Discovered that this platform's own public preview URL doesn't pass through WebSocket upgrade
requests (`502` on any `Upgrade: websocket` header, confirmed even on plain routes) — a hard requirement
for Twilio Media Streams. A Cloudflare quick-tunnel (`cloudflared tunnel --url ...`, no account needed) was
stood up as a workaround, and it already dropped once mid-test (`"no recent network activity"` in tunnel
logs), independent of anything in the application code.

**Decision:** Use the quick-tunnel to unblock real-call testing in the short term, but explicitly document
it as unfit for anything beyond occasional manual testing — not a production access path.

**Consequences:** Any further live-call testing inherits this instability until resolved. Two real fixes
are on the table (recorded as an open decision, not yet made): (1) an authenticated Cloudflare named
tunnel (still free, requires a Cloudflare account + domain, far more stable), or (2) deploying the server
to a persistent host outside this sandbox with its own stable domain. This ADR exists so the tradeoff isn't
forgotten or mistaken for a solved problem in future work.

---

## ADR-009 — Evaluated and rejected LiveKit Agents as an orchestration layer
**Date:** 2026-07-04

**Context:** After market research showed Vent's STT→LLM→TTS orchestration isn't novel (Pipecat, LiveKit
Agents, TEN Framework, and Vocode all solve this with bigger plugin ecosystems and more production
mileage), the idea of adopting one of these frameworks instead of maintaining Vent's own hand-rolled
pipeline was raised and investigated. LiveKit Agents was the strongest candidate — it ships an official
TypeScript SDK (matching Vent's Bun/TypeScript stack, unlike Pipecat which is Python-only server-side) and
has documented Twilio integration patterns.

Deeper investigation surfaced two disqualifying problems:
1. **Both LiveKit deployment options reintroduce the exact dependency Vent exists to remove.** LiveKit
   Cloud puts a third-party vendor between the operator and their own calls — the black-box-platform
   pattern Vent's positioning argues against, plus another account/API-key set every adopter would need.
   Self-hosted LiveKit requires running a media server (SFU) + Redis for room-state coordination, meets
   LiveKit's own recommended baseline of 4 CPU cores / 8GB RAM per agent server, and needs a domain + SSL
   certificate + Docker/Kubernetes — a large new operational burden for every person who adopts Vent, the
   opposite of the "less hustle for our users" goal.
2. **Architectural mismatch with Twilio.** Vent's current pipeline uses Twilio Media Streams, a
   WebSocket-based audio bridge. LiveKit's telephony model is WebRTC + SIP trunking — a different
   transport entirely. Twilio's own support docs confirm they do not offer a SIP-over-WebSocket endpoint,
   so bridging the two requires an extra translation layer (Twilio → SIP trunk → LiveKit dispatch rules →
   LiveKit room); public GitHub issues describe this specific bridge behaving unreliably in production.

**Decision:** Reject adopting LiveKit Agents (or any hosted/self-hosted orchestration framework) for
Vent's core pipeline. Keep and continue hardening the existing direct Twilio Media Streams + Deepgram +
swappable-LLM + swappable-TTS pipeline, which is already built, already proven on a real call, and
requires no infrastructure beyond the API providers a user already needs.

**Consequences:** Vent will not benefit from Pipecat's/LiveKit's larger plugin ecosystems or their ongoing
engineering investment in raw pipeline features (turn-detection tuning, WebRTC transport optimizations,
etc) — that tradeoff is accepted deliberately. The "leverage" identified in earlier research (that no
competitor, hosted or open-source, ships automatic compliance/workflows/control) remains the correct place
to invest instead, since it doesn't require adopting anyone else's infrastructure to build. This decision
supersedes the direction implied by the (unexecuted) LiveKit migration plan from earlier the same day — no
code was migrated before this reversal, so no rollback was needed.

---

## ADR-010 — Extracted the compliance layer into a standalone, framework-agnostic package
**Date:** 2026-07-05

**Context:** Following ADR-009's decision to keep Vent's direct pipeline instead of adopting an
orchestration framework, the identified leverage — automatic compliance that no competitor (hosted
platform or open-source framework) ships out of the box — needed to become concrete rather than aspirational.
Vent's compliance modules (`calling-window`, `dnc`, `consent`, `hipaa`, `gdpr`) were originally written
directly against Vent's own Drizzle/Turso schema, which meant they could only ever be "a compliance layer
inside one app," not something another developer — on any telephony stack or orchestration framework —
could adopt independently.

**Decision:** Extract all five compliance modules into a new workspace package, `packages/openvent-compliance`
(published as `@openvent/compliance`), with zero dependency on Twilio, Bun/Hono, or any specific database.
Storage-backed modules (`dnc`, `gdpr`) now accept a small adapter interface (`DncStorageAdapter`,
`CallLogStorageAdapter`) instead of importing Vent's `db` directly; in-memory reference adapters ship in
the package for quick starts and tests. Vent's own app was then refactored to consume the extracted
package via a thin Drizzle adapter (`packages/web/src/api/voice/compliance/adapters.ts`) — proving the
extraction works standalone by dogfooding it in the real, working app rather than leaving it untested.

**Consequences:** The package was verified with 13 unit tests covering every module using only the
in-memory adapters (no Vent-specific code touched), and the app's existing compliance behavior (DNC block,
calling-window enforcement, GDPR erasure, health-check reporting) was regression-tested via the same curl
checks used in prior sessions — all passed identically after the swap. This is the first concrete step of
the "library → framework" roadmap: the compliance layer is now something a Pipecat, LiveKit, or entirely
custom voice pipeline could adopt without adopting Vent itself. Packaging for public npm distribution
(making this installable outside this monorepo) remains a separate, not-yet-executed step.

---

## ADR-011 — v1.3 hardening pass: auth, signature validation, retry-cap fix, rate limiting
**Date:** 2026-07-05

**Context:** Before treating v1 as "done," a hardening pass was needed to close the gap between "works in
a sandbox with a trusted operator" and "safe to expose publicly." Several issues existed: ops endpoints had
no auth at all; Twilio webhooks accepted any request regardless of origin (forgeable); workflow retries had
a `maxRetries` field that was never actually checked, so a bad workflow config could redial a number
forever; the scheduler could double-execute a scheduled call under concurrent ticks; outbound calls had no
rate ceiling; and `sendSms` was a stub that logged instead of sending.

**Decision:** Close all of the above in one pass, each as the smallest correct fix rather than a bigger
redesign:
- Admin-key middleware (`X-Vent-Admin-Key` vs `ADMIN_API_KEY`) in front of every ops endpoint, warn-not-crash
  if unset (keeps local dev frictionless, makes the risk visible).
- Twilio's official request-signing scheme (`twilio.validateRequest`) in front of every inbound webhook.
- Atomic `pending`→`claimed` claim (conditional `UPDATE ... RETURNING`) in the scheduler, with a reset back
  to `pending` for calling-window-deferred rows (fixing a second, related bug where those rows got
  permanently stuck as `claimed`).
- `previousAttempt`/`nextAttempt` tracking so `maxRetries` is actually enforced.
- A basic fixed-window rate limiter on `/calls/outbound`, explicitly additive to (not a replacement for)
  the existing DNC/calling-window compliance gates.
- Wired `sendSms` to `twilioClient.messages.create()` for real.
- A National DNC registry *adapter shape* (`syncNationalDncRegistry`, `NationalRegistryFetcher`), shipped
  as a documented stub (`noopNationalRegistryFetcher`) rather than a real integration — the real US
  National DNC Registry requires a SAN (Subscription Account Number) that can't be provisioned in this
  sandbox. This closes the "we said we'd design for this later" gap from ADR-007 without pretending it's
  live.
- A tunnel supervisor script (`scripts/tunnel-supervisor.sh`) that watches `cloudflared`, restarts it on
  crash, and keeps `PUBLIC_APP_URL` + the Twilio webhook in sync with the tunnel's (rotating) URL. This is
  explicitly a mitigation for the quick-tunnel stopgap from ADR-008, not a fix for the underlying problem —
  the real fix remains a named tunnel or a persistent real domain.

**Consequences:** 12 new web-app tests and 2 new compliance-package tests added (40 total across both
packages, all passing); typecheck and build both clean. Regression-verified via curl: DNC add/list/remove,
E.164 rejection on `/dnc` and `/calls/outbound`, DNC-blocked outbound call returns `403`, malformed JSON
returns `400` not `500`, unsigned Twilio webhook rejected `403`, admin-key gate returns `401`
without/with-wrong key and `200` with the correct key. npm publishing of `@openvent/compliance` (ADR-010's
"remains a separate step") is still deferred — this round is about hardening the existing surface, not
distribution.

---

---

## ADR-012 — Structured call state as ground truth, not the transcript
**Date:** 2026-07-05

**Context:** A recurring production failure mode in voice agents (surfaced via a Reddit thread analyzed
alongside this project's own market research) is that agents re-ask for information the caller already
gave, or contradict earlier answers, once that information scrolls outside whatever the model effectively
attends to. This isn't a model-quality problem — it happens even with strong models — because the only
"memory" most voice-agent stacks have is the raw transcript (or a lossy summary/RAG layer over it), with no
deterministic, structured source of truth the agent is required to read from. Vent had this same gap:
`history: ModelMessage[]` was the only state a call carried.

**Decision:** Add a structured `CallState` layer that sits alongside, not instead of, the transcript:
- A new `captureField` tool (`voice/tools/captureField.ts`) lets the agent explicitly record a durable fact
  (email, order ID, name, callback time, etc.) as a `{ field, value }` pair the moment the caller states it,
  rather than leaving extraction implicit in free text.
- `calls.capturedState` (new JSON column) and `CallSession.capturedState` (session-store) hold this as a
  plain `Record<string, string>` — deterministic, inspectable, and persisted continuously (on every
  `captureField` call, not just at call end) so it survives a mid-call crash and shows up on the dashboard
  immediately.
- `agent.ts`'s `buildKnownFactsBlock()` renders the current state as an explicit "Known facts — already
  confirmed, do not ask for these again" block appended to the system prompt every turn. The model is told
  what's known instead of being expected to re-derive it from scrollback.
- This was deliberately scoped as a feature *within* Vent's existing compliance/self-hosted positioning,
  not a repositioning of the project. Compliance, audit logging, and debugging all benefit from the same
  structured state (a captured `disposition` or DNC-triggering fact is exactly this kind of data already);
  this generalizes that pattern instead of introducing a separate identity for it.

**Consequences:** Two new test files (`agent.test.ts`, `tools/captureField.test.ts`, 6 tests) exercise
`buildKnownFactsBlock`'s empty/populated/multi-field/non-mutating behavior and the tool's shape; full suite
(48 tests across both packages) still green, typecheck and build clean, `db:push` applied the new column
with no manual migration needed (SQLite JSON text column). A companion dashboard (`/dashboard`) was built in
the same round specifically to make captured state visible and auditable per call, not just log lines — see
the dashboard section of README.md. Not done in this round: no automatic slot *schema* per persona (i.e. no
way to declare "this persona must capture email + order_id before ending the call") — the model decides
what's worth capturing based on the tool description alone. That's a reasonable next step if this needs to
become stricter (e.g. compliance-required fields) rather than best-effort.

---

## ADR-013 — Named Cloudflare tunnel replaces the quick-tunnel supervisor
**Date:** 2026-07-05

**Context:** ADR-008 documented the free `trycloudflare.com` quick-tunnel's core problem: it assigns a new
random URL on every restart, so `PUBLIC_APP_URL` and the Twilio Voice webhook drift out of sync whenever
the tunnel drops. ADR-011's `tunnel-supervisor.sh` mitigated the pain (auto-restart + auto-update the
webhook on URL change) but explicitly said the real fix was a named tunnel or a persistent real domain.
The user now has a Cloudflare account and a domain (DNS managed on Vercel, not moved to Cloudflare).

**Decision:** Create a real named Cloudflare Tunnel via the Cloudflare API rather than the quick-tunnel:
- `POST /accounts/:id/cfd_tunnel` creates a persistent tunnel with a fixed ID; ingress config routes
  `vent.<domain>` → `http://localhost:4200` via `PUT /accounts/:id/cfd_tunnel/:id/configurations`.
- DNS stays on Vercel — a tunnel only needs a CNAME pointing at `<tunnel-id>.cfargotunnel.com`; moving the
  zone to Cloudflare was never required. This CNAME is added manually in Vercel's panel (not automatable
  without Vercel API credentials, which weren't requested).
- The tunnel token is stored in `.cloudflare-tunnel-token` (repo-root, gitignored, never committed) rather
  than passed inline on the command line, to avoid it ending up in shell history or a tmux pane buffer.
- Run via `scripts/run-cloudflare-tunnel.sh`, managed by PM2 (`cloudflare-tunnel` process) alongside
  `web-app` — consistent with how the main server is already supervised, and gives automatic restart on
  crash without a separate bash-loop supervisor.
- `tunnel-supervisor.sh` (ADR-011) is kept in the repo but marked superseded — still useful as a fallback
  for local dev without a domain, but no longer what's actually running.
- `PUBLIC_APP_URL` and the Twilio number's Voice webhook were both updated to the new fixed hostname; no
  more rotation, so no auto-update logic is needed for this path (unlike the quick-tunnel's URL-on-every-
  restart problem).

**Consequences:** This closes the last open item from ADR-011's hardening round. The tunnel has a fixed
hostname now, so call quality/webhook delivery no longer depends on catching a URL-rotation event in time.
Tradeoff: standing up this tunnel required real Cloudflare account credentials (API token, account ID) —
fine for this project since the user has them, but means the setup isn't zero-account like the quick-tunnel
was; documented in README as an optional-but-recommended step for anyone self-hosting Vent long-term.

---

## ADR-014 — Reverted ADR-013: back to the quick-tunnel, named tunnel parked
**Date:** 2026-07-05

**Context:** ADR-013's plan assumed a plain CNAME on Vercel's DNS could point at a Cloudflare Tunnel. It
can't: `<tunnel-id>.cfargotunnel.com` only resolves inside Cloudflare's own proxy network, so the hostname
has to actually be *proxied by Cloudflare* (orange-cloud on), not just pointed at from an external DNS
provider. The fix would have been Cloudflare's Partial (CNAME) Setup — letting Cloudflare proxy one
subdomain while everything else stays on Vercel — but Cloudflare has since restricted that to
Enterprise/partner accounts; free-tier setup now requires migrating the zone's nameservers to Cloudflare
entirely (Vercel hosting would still work fine as DNS-only records after the move, but it's real migration
effort and propagation time).

**Decision:** Not worth it right now. The project is heading into a Reddit/community-feedback and
build-in-public phase, not a public launch depending on a stable domain — the free quick-tunnel's rotating
URLs are a non-issue at this stage since `tunnel-supervisor.sh` (ADR-008/ADR-011) already auto-updates
`PUBLIC_APP_URL` and the Twilio webhook on every rotation. Reverted: killed the `cloudflare-tunnel` PM2
process, restarted the quick-tunnel under the existing supervisor script, confirmed `/api/health` responds
`200` on the new quick-tunnel URL after a `pm2 restart web-app --update-env`.

**Consequences:** `scripts/run-cloudflare-tunnel.sh` and the Cloudflare tunnel/DNS config created in
ADR-013 are left in place (tunnel still exists, ingress still configured) in case nameserver migration
happens later — nothing to redo except re-adding the CNAME once DNS actually sits on Cloudflare. No code
changes this round, only infra/ops. Revisit named-tunnel setup once there's a real reason for a stable
public domain (real user traffic, a production launch) rather than doing it preemptively.

---

---

## ADR-015 — Open-core framework, not a pure library or a pure hosted platform
**Date:** 2026-07-05

**Context:** Early community feedback (Reddit, pre-launch research round) raised a concrete gap:
"lack of good integrations... their ability to listen to me and understand what I want to do" — i.e. Vent
doesn't fit into the tools people already run, and the one CRM integration that exists (`crmSync`,
HubSpot-only) is a hardcoded stub. Answering that well required deciding what Vent actually *is* as a
product, not just what to build next — because "add more integrations" implies very different things
depending on whether this is a library, a framework, or a platform.

Three shapes were considered:
- **Pure library** (just `@openvent/compliance` and friends on npm): low switching cost for adopters, but our
  own market research showed this doesn't monetize directly — GitHub Sponsors plus a hosted convenience
  layer is the standard pattern for OSS infra, not download counts alone. Also weak as something to pitch —
  "we maintain an npm package" isn't a fundable story.
- **Pure hosted platform** (compete directly with Vapi/Retell/LiveKit Cloud): would abandon Vent's actual
  edge. The single most-repeated complaint surfaced in the market research was "the biggest issue isn't the
  tech, it's the lock-in" — going head-to-head with well-funded managed platforms puts Vent in the one lane
  where it has no advantage.
- **Open-core framework** (chosen): the self-hosted pipeline (Twilio/Deepgram/LLM/TTS, the state engine,
  the compliance module, the dashboard) stays free and fully open — this is the trust mechanism for the
  self-hosted/OSS audience the research validated, and every claim about "your keys, your data" stays
  independently verifiable by reading the code. A paid layer ("Vent Cloud") sits on top: managed hosting so
  people don't have to hand-roll tunnels/PM2/Twilio wiring, a hosted multi-tenant dashboard, premium
  pre-built integrations (see the GoHighLevel/Salesforce/Google Calendar work started this round), and —
  directly solving today's stub — a paid, hosted national DNC registry sync (Vent holds the FTC SAN
  subscription once, amortized across many customers, instead of each self-hoster needing their own).

**Decision:** Vent is an open-core framework. Free/open forever: the core pipeline, state engine,
compliance primitives (DNC list, calling-window enforcement, GDPR erasure), and dashboard. Paid, later:
managed hosting, premium integrations, hosted national DNC sync, enterprise/HIPAA support. This is the
model used by comparable OSS infra companies (Supabase, n8n, PostHog) and is a recognizable, fundable shape
if this is ever pitched: "self-hosted and free to verify, or pay us to host it and handle the regulatory
parts you don't want to own yourself."

**Consequences:** Near-term work (integration resilience wrapper, GoHighLevel/Salesforce/Google Calendar
integrations) is unchanged in scope but is now understood as the seed of the future paid tier, not just
"more open-source features" — worth keeping in mind when deciding what ships free vs. gated later. Bigger
follow-on work this implies but does not require yet: multi-tenancy, billing, a hosted deploy path — none
of that is being built now, only decided as the direction. No code changes this round.

---

---

## ADR-016 — "Self-hosted" reframed as a three-tier spectrum, not a binary claim
**Date:** 2026-07-05

**Context:** Early Reddit feedback (r/AI_Agents, r/VoiceAutomationAI — see `reddit-feedback.md`, not
committed) pushed back, correctly, on calling Vent "self-hosted" without qualification: "self-hosted is a
bit of a stretch if you're still routing through Twilio and Deepgram, the data still goes through their
servers," and a sub-reply: "true self-hosted voice AI is nearly impossible end to end because PSTN is
always a third party." Both are right. Vent has never run its own telephony network or its own LLM
inference, and saying "self-hosted" without qualification invited the reasonable assumption that it might.

Talking this through surfaced a clearer model: voice-agent architectures sit on a spectrum, not a binary.
One end is fully local (Ollama/local-LLM + local STT/TTS, zero cloud dependency, real but requires owning
GPU hardware and accepting a quality/latency tradeoff against frontier cloud models — this is what
r/LocalLLaMA is actually about). The other end is fully managed (Vapi, Retell, LiveKit Cloud — zero infra
to run, but zero control, no data ownership, no provider choice). Vent sits in the middle: the
*orchestration layer* is self-hosted (code, database, call logic, compliance rules, dashboard — all
inspectable and owned by the operator) while the *AI layer* (LLM inference, STT, TTS) and the *telephony
layer* (PSTN via Twilio) remain cloud APIs by necessity — no one can self-host a phone network, and
running frontier-quality LLM inference locally is a different, harder product with its own real tradeoffs.

**Decision:** Stop using "self-hosted" as an unqualified, standalone claim. Adopt "self-hosted
orchestration, bring-your-own AI providers" as the precise, headline description everywhere it matters
(README, docs, landing page, the agent's own description of itself). Do not chase the fully-local end of
the spectrum as a roadmap item — that's a different product with different tradeoffs (GPU cost, latency,
model-quality ceiling), and it's not what the compliance/state-engine/no-lock-in bets already made are
built around. Own the middle of the spectrum deliberately, and be explicit about exactly which layer is
owned vs. which layer is still a cloud API — precision reads as more trustworthy to this exact developer
audience than a vaguer, more sweeping claim, especially once someone opens the code and finds Twilio and an
AI Gateway client in there.

**Consequences:** Copy updated in this round: README hero/feature copy, `docs/architecture.md`, the
landing page hero/problem sections, and the voice agent's own persona description (`agent.ts`'s
`DEFAULT_PERSONA`, which explains what Vent is if a caller asks) — all now describe the three-tier
spectrum and Vent's specific position on it, rather than a bare "self-hosted" claim. This is a
documentation/positioning change only, no functional code changes. Drafted (not yet posted) Reddit replies
acknowledging the original feedback directly and pointing to this clarification are in
`reddit-feedback.md`.

---

## ADR-017 — Compliance audit-trail export
**Date:** 2026-07-06

**Context:** Direct, repeated community feedback (see `reddit-feedback.md`, not committed, and
`docs/strategy-2026-07.md`) identified a concrete gap: Vent enforces compliance (DNC, calling-window,
recording/AI disclosure) but never packaged what it enforces into something an operator could hand to a
lawyer or compliance officer on demand. Direct quote from feedback: "the thing that actually kills the
compliance fear isn't more warnings, it's being able to show who called whom, with what consent, and what
the agent said." All of that data already existed (`calls`, `transcripts`, `doNotCall` tables) — it just
required manual reconstruction across multiple tables, which is exactly the wrong thing to be doing under
the pressure of an actual regulatory inquiry.

**Decision:** Add an audit-trail module to `@openvent/compliance` (`audit-trail.ts`), following the package's
existing storage-adapter pattern (`CallAuditStorageAdapter`, sibling to `DncStorageAdapter`/
`CallLogStorageAdapter`) so it stays framework-agnostic and adoptable outside Vent's own app. It assembles,
per call: direction, numbers, timing, status, disposition, current DNC status (checked at export time, not
call time, since a number can be DNC'd after a call happened), full transcript, and — the one piece that
required real judgment — whether the recording/AI disclosure was *actually spoken*, not just configured
on. That check does a conservative substring match against the first agent transcript turn; a false
"not confirmed" is the safe failure direction (prompts a human to double-check), a false "confirmed" would
not be.

Two entry points: `buildCallAuditRecord` (one call) and `buildPhoneNumberAuditTrail` (every call involving
a number — the more common real request). `renderAuditTrailText` formats either as plain text suitable for
handing to a lawyer as-is; JSON is available by serializing the records directly for programmatic/tooling
use. Wired into the app via a Drizzle adapter (`voice/compliance/adapters.ts`'s `callAuditAdapter`,
following the exact pattern of the existing `dncAdapter`/`callLogAdapter`) and two new admin-key-gated
routes: `GET /calls/:id/audit` and `GET /callers/:phoneNumber/audit`, both supporting `?format=text`.
Surfaced in the dashboard two ways: an "Export compliance audit" button on the call-detail page, and a new
dedicated `/dashboard/audit` page for the per-number lookup case.

**Consequences:** 10 new tests in `openvent-compliance` (25 total in that package, 74 across both packages),
typecheck/build/lint all clean, and the two new endpoints were regression-tested live against real call
data (401 without admin key, 404 for an unknown call id, 200 with an empty array for a number with no
calls, correct oldest-first ordering for multi-call lookups, correct disclosure-confirmed/not-confirmed
detection against real transcripts). This is the first concrete build item to come directly out of the
community feedback rounds (see `docs/strategy-2026-07.md`) — previously "in progress" items (integrations,
resilience layer) were already done; this was reprioritized ahead of the other candidates (per-call latency
breakdown, cross-call memory) because it was cheapest, most differentiated, and most directly requested.
Not done in this round: no PDF export (plain text was judged sufficient for "hand this to a lawyer" and
avoids a new dependency); no bulk/all-numbers export (per-number and per-call cover the realistic request
shapes identified in feedback).

---

## ADR-018 — Switch from MIT to a fair-code license (Vent Sustainable Use License)
**Date:** 2026-07-07

**Context:** ADR-015 already committed Vent to an open-core model — self-hosted core free forever, a paid
"Vent Cloud" layer later — explicitly citing n8n, Supabase, and PostHog as the comparable shape. Those
projects don't ship under plain MIT, though: n8n uses the Sustainable Use License, Supabase mixes Apache
2.0 with some fair-code-style components on premium pieces. Plain MIT (Vent's license until now) grants
anyone the right to fork, host, and resell the software as a competing managed service, royalty-free, with
no obligation back — which directly undercuts the future "Vent Cloud" paid layer ADR-015 already decided
to build. At zero external users and zero forks today, this is the cheapest point to fix it; once outside
contributors or forks exist, relicensing needs their consent and gets materially harder.

**Decision:** Replace the MIT `LICENSE` with the **Vent Sustainable Use License** (adapted from n8n's
Sustainable Use License v1.0): free to self-host, modify, and use for internal business or personal
purposes, forever, with source fully readable and verifiable — but not licensed for repackaging as a
competing hosted/managed commercial service without a separate commercial license from the licensor. No
`.ee`-style file-level split was introduced in this round (that's a bigger structural change to defer until
there's an actual premium-integration surface worth gating); the whole repo moved to the new license as one
change. `README.md`'s license section and `packages/openvent-compliance/package.json`'s license field were
updated to match.

**Consequences:** Anyone already relying on Vent under the old MIT terms before this commit keeps those
rights for the code as it existed then (MIT grants don't retroactively revoke), but all code from this
commit forward is fair-code licensed. No functional code changes. This is a licensing/positioning change
only, made now specifically because the project has no external contributors or forks yet to complicate
it.

---

## ADR-019 — Full rebrand from "Vent" to "OpenVent"
**Date:** 2026-07-08

**Context:** The exact domain `vent.com`/`.dev`/`.org`/`.app`/`.ai`/`.io`/`.co` was unavailable across every
budget-reasonable TLD. `openvent.dev` was available at a flat, honest renewal price (no bait-and-switch
TLD pricing), and — unlike a suffixed domain trick (e.g. `getvent.dev`) — "OpenVent" also does real
positioning work: it puts the project's actual thesis (open-core, self-hosted, read-the-code-before-you-
trust-it) directly in the name, not just the URL. The alternative considered was keeping the product name
"Vent" and only using a prefixed domain — cheaper to execute, but it leaves the domain and the brand saying
two different things forever.

**Decision:** Full rename, not just a domain-layer relabel: product name, landing page copy, docs, README,
LICENSE (now the "OpenVent Sustainable Use License"), the standalone compliance package (`@vent/compliance`
→ `@openvent/compliance`, folder `packages/vent-compliance` → `packages/openvent-compliance`), and the
admin-auth header (`X-Vent-Admin-Key` → `X-OpenVent-Admin-Key`, updated in both the frontend client and the
backend middleware that reads it). Alongside the rename, added a full SEO/AEO layer that didn't exist
before: `index.html`'s title was a literal placeholder (`"Web"`) with no meta description, no Open Graph
tags, and the `og-image.png` was an unrelated leftover template asset — all replaced with real OpenVent-
specific meta tags, a new branded OG image, `SoftwareApplication` + `FAQPage` JSON-LD, `robots.txt`,
`sitemap.xml`, and `llms.txt` (a plain-text summary aimed at AI answer engines/crawlers). A visible FAQ
section was added to the landing page itself so the `FAQPage` schema reflects real on-page content rather
than being schema-only (search engines can penalize or ignore structured data that doesn't match visible
page content).

**Consequences:** Historical entries above this one in this file are left as originally written — they
correctly record what the project was called and how the package was named at the time each decision was
made. Only this entry and everything going forward uses "OpenVent." The GitHub repository itself was not
renamed (still `github.com/I-invincib1e/vent`) — GitHub repo renames risk breaking the existing Vercel Git
integration, and the badge/link in `README.md` already points at the correct fork; only the product's own
name, package name, and public-facing copy changed. No functional code changes beyond the header rename
(compliance/auth logic itself is untouched).

---

## ADR-020 — Landing page storytelling rebuild: real logos, scroll-driven diagram, drop stale demo data
**Date:** 2026-07-08

**Context:** The landing page's Product Tour section showed screenshots that had gone stale — old
"Vent" branding, a placeholder phone number, a fake test transcript — while still claiming "not a
mockup, real calls." Separately, the pipeline diagram used generic lucide icons with text labels
("Twilio", "Deepgram", "ElevenLabs") instead of the providers' actual marks, and every section used
the same simple viewport-enter fade regardless of what it was trying to communicate.

**Decision:** Three changes, done together:
1. Removed the Product Tour section and its three stale screenshots entirely (`packages/web/public/
   demo/`) rather than patch them — real screenshots come later, once there's a current instance to
   capture, not before.
2. Replaced the linear icon-based pipeline with a real boxes-and-hub architecture diagram
   (`architecture.tsx`) using the providers' actual official marks (Twilio, Deepgram, ElevenLabs,
   Cartesia, Groq, n8n, Zapier, GitHub — sourced from simple-icons, Wikimedia Commons, and Cartesia's
   own site directly, never AI-generated, normalized to single-color `currentColor` React components
   in `logos.tsx` so they recolor with the rest of the UI instead of clashing brand colors), plus a
   real interactive piece: clicking the TTS node swaps its label/logo between ElevenLabs and Cartesia,
   demonstrating the actual env-var provider swap instead of just describing it in prose.
3. Gave each remaining section a scroll treatment that matches what it's saying, not a uniform fade:
   the provider strip is now an infinite logo marquee (pauses on hover), the Problem comparison table
   reveals row-by-row tied to scroll position, Features/Shipped use a scroll-stack effect (cards
   settle into place as the next arrives), Roadmap's "shipped" checkmarks scale in as you scroll past
   them, and the FAQ became a real accordion (first item open by default) instead of everything always
   expanded — while keeping every answer's text present in the DOM so the `FAQPage` JSON-LD schema
   still matches real page content. Added GSAP + `@gsap/react` for the one component (`split-text.tsx`,
   a character-by-character reveal on the hero's "OpenVent") where GSAP is a meaningfully better fit
   than Motion for staggering dozens of individual tweens; everything else stays on Motion
   (framer-motion), already the project's animation library.

**Consequences:** No backend/data changes — this is a landing-page-only round. `bunx tsc --noEmit`
and `bunx vite build` both clean, all 25 `@openvent/compliance` tests still passing (untouched by this
round). One real bug caught during this work worth noting for future editing sessions: several
sub-component definitions (`ProblemRow`, `DoneItem`) were dropped by an editing pass that replaced
their call sites without the definitions actually landing in the file, causing runtime
`ReferenceError`s that only surfaced in the browser console, not in `tsc`or the build step — worth
double-checking rendered output in-browser after structural refactors, not just relying on
typecheck/build passing.

---

## ADR-021 — Telephony provider abstraction: deferred, scoped, documented (no code this round)
**Date:** 2026-07-08

**Context:** Starting a round of work on four roadmap items (per-call latency breakdown, cross-call
memory, multi-user dashboard auth, Redis session storage), the question of "shouldn't OpenVent not be
Twilio-specific" came up. Worth deciding deliberately rather than either ignoring it or scope-creeping
this round into a telephony rewrite. Concrete coupling points found during exploration, so this is a
scoped decision, not a vague aspiration:

- `packages/web/src/api/database/schema.ts` — `calls.twilioCallSid` bakes Twilio's naming into the
  schema itself, not just an implementation detail.
- `packages/web/src/api/voice/routes.ts` — `/incoming`, `/status-callback`, `/recording-status` are
  shaped exactly like Twilio's webhook contract; outbound calling goes through `twilioClient.calls.create()`
  directly, no intermediate interface.
- `packages/web/src/api/voice/middleware/twilio-signature.ts` — signature validation is Twilio-specific
  by construction (Twilio's own HMAC scheme).
- `packages/web/src/api/voice/stream.ts` — the per-call WebSocket state machine assumes Twilio Media
  Stream's exact event shape (base64 mu-law frames, `start`/`media`/`stop` events) with no abstraction
  layer between "a phone call is happening" and "Twilio specifically is happening."

**Decision:** Not touched this round. The four roadmap items below don't require it, and doing it
properly (a `TelephonyProvider` interface, renaming `twilioCallSid` → a generic `providerCallId`,
abstracting the Media Stream event shape) is its own significant, separate piece of work that deserves
its own dedicated round rather than being bolted on as a side effect of unrelated work. Recording this
now so the eventual work has a concrete starting list instead of starting from scratch.

**Consequences:** No code changes. `ROADMAP.md`'s "Later" section updated to reference this ADR instead
of a bare one-line mention, so the next person (or the next round) picking this up has the actual
coupling points to work from.

---

## ADR-022 — Per-call latency breakdown: first-value-only, persisted once at call end
**Date:** 2026-07-08

**Context:** LLM time-to-first-token was already computed (`agent.ts`'s `onLatency` callback) but only
`console.log`'d in `stream.ts`, never surfaced. STT connect time and TTS first-audio-byte time weren't
tracked at all. Flagged repeatedly as the top remaining ask from the community feedback rounds
(`docs/strategy-2026-07.md`).

**Decision:** New table `callLatency` (one row per call, additive migration, `callId` as primary key),
three nullable columns: `sttConnectMs`, `llmTtftMs`, `ttsFirstByteMs`. Each is captured **once per call,
first value wins** — not per-turn, not continuously updated. STT connect is captured in `deepgram.ts` on
the first successful `open` event (guarded so reconnects don't overwrite it — that's already covered by
the separate `sttReconnectCount`/`totalGapMs` stats). LLM TTFT is captured from whichever turn produces
a value first — usually the greeting, since `runVoiceAgentGreeting` didn't previously forward
`onLatency` at all and now does. TTS first-byte is captured by wrapping the existing `onAudioChunk`
forwarding callback in `stream.ts`'s `speak()` with a `Date.now()` delta on the first chunk of the
first turn, rather than modifying `elevenlabs.ts`/`cartesia.ts` — keeps the TTS provider files untouched
and provider-agnostic, matching the existing abstraction (see ADR referenced in `docs/architecture.md`).
Unlike `capturedState`, latency isn't persisted continuously mid-call (no crash-recovery need for it) —
one row is written in `finalizeCall()`, and only if at least one metric was actually captured (a call
that failed before Deepgram ever connected doesn't get a pointless all-null row).

**Consequences:** New `GET /calls/:id/latency` endpoint, new "Latency breakdown" panel on the call-detail
dashboard page — renders "not recorded" per-field rather than `0ms` or crashing for calls with no data
(historical calls before this shipped, or calls that failed early). No changes to the TTS/STT provider
files' own interfaces — the timing wrap lives entirely in `stream.ts`, the one place that already
orchestrates all three stages. Not unit-tested in the traditional sense (the capture points are wired
into `stream.ts`'s WebSocket state machine and the real STT/TTS network connections, which the existing
test suite doesn't mock — consistent with how `stream.ts` itself has no direct unit tests today);
verified via `tsc`/`vite build`/existing 49-test suite passing unchanged, plus a manual dashboard render
check for both the populated and null-field cases.

---

---

## ADR-023 — Cross-call memory: flat key/value overlay, merged not replaced
**Date:** 2026-07-08

**Context:** `capturedState` (ADR-012) is scoped to a single call — a returning caller starts from zero
every time, which the ROADMAP had already flagged ("OpenVent doesn't have this at all today"). Needed a
mechanism that survives across calls without turning into a second, competing source of truth against
`capturedState`, and without an unbounded per-caller history that would grow the prompt injection cost
forever.

**Decision:** New table `callerMemory`, one row per phone number, a flat JSON key/value `facts` column —
deliberately the same shape as `capturedState`, not a free-text summary and not a call-by-call log. On
each call's `finalizeCall`, `upsertCallerMemory` merges that call's `capturedState` into the existing
row (`{ ...existing, ...newFacts }` — later calls overwrite matching keys, new keys accumulate), a no-op
if nothing was captured. No LLM summarization call involved — this stays free to compute. Which number
is "the human" depends on call direction (`resolveHumanNumber`): `fromNumber` on an inbound call, but
`toNumber` on an outbound call, since `fromNumber` there is the operator's own Twilio number, not a real
person — worth a dedicated pure function since getting this backwards would silently key memory off the
operator's own number. Injected into the system prompt via `buildCallerMemoryBlock`, clearly labeled
"from a previous call... may be outdated" — distinct wording from `buildKnownFactsBlock`'s this-call
facts, which the model treats as settled ground truth. `runVoiceAgentGreeting` previously didn't forward
`onLatency` *or* accept `callerMemory` at all — both gaps fixed together since they're the same call site.

**Consequences:** New `caller-memory.ts` module, `resolveHumanNumber` unit-tested directly (pure
function); `getCallerMemory`/`upsertCallerMemory` aren't unit-tested against a real DB (consistent with
how the rest of this file's DB-touching code is verified — integration-level via the live pipeline, not
mocked). No changes to `capturedState`'s own behavior or table. Additive migration only.

---

## ADR-024 — Fixed a repo-wide silent typecheck gap: `tsc --noEmit` was checking nothing
**Date:** 2026-07-08

**Context:** While building Phase 1/2, `bunx tsc --noEmit` (invoked exactly as `packages/web`'s
`typecheck` and `build` scripts run it, and exactly as `.github/workflows/ci.yml` runs it in CI)
reported zero errors on a file that was — confirmed by direct inspection — missing an import and
referencing an undefined name. Root cause: `packages/web/tsconfig.json` is a solution-style config
(`"files": []`, only `"references"` to `tsconfig.app.json` and `tsconfig.node.json`). Running plain
`tsc --noEmit` against a references-only config with no `--build` flag does nothing — it doesn't error,
it silently type-checks an empty file set and exits 0. This has been true since the project template was
scaffolded, meaning **CI's typecheck step, and every "tsc clean" verification claimed in this project's
history (including this session's own ADR-020 and ADR-022), was not actually checking anything.**
Running `tsc -b` (or `-p tsconfig.app.json` / `-p tsconfig.node.json` explicitly) surfaced real,
pre-existing errors: several dashboard pages (`calls-list.tsx`, `dnc.tsx`, `call-detail.tsx`) accessed
properties directly on a Hono client's `{error} | {data}` union return type without narrowing first
(worked at runtime because the error branch never actually fires in normal use, but was never provably
type-safe), `admin-key-gate.tsx`'s typed RPC call resolved to `never` (root cause not fully isolated;
worked around by using a plain `fetch` there instead, since that call site only needs the HTTP status,
not a typed payload), `dnc.tsx` used a nonexistent `entry.id` (the DNC entry type has no `id` field —
fixed to key on `entry.phoneNumber`, which is actually unique), an unused `motion` import in `stack.tsx`,
and a `MotionValue<unknown>` vs `MotionValue<number>` mismatch in `architecture.tsx` from an untyped
`ReturnType<typeof useTransform>`. Also surfaced, and separately worth noting: this session's own edits
to `stream.ts`, `deepgram.ts`, `agent.ts`, `routes.ts`, and `call-detail.tsx` had several instances of an
edit silently not landing (a call site referencing a name that was never actually declared) — invisible
until real typechecking existed to catch it.

**Decision:** Changed `packages/web/package.json`'s `typecheck` script from `tsc --noEmit` to `tsc -b`,
and `build` from `tsc --noEmit && vite build` to `tsc -b && vite build` — both now honor the project
references and actually check `src/web` and `src/server.ts`/`vite.config.ts`. Fixed every error this
surfaced (listed above) rather than just the ones blocking this round's own work. Fixed
`.github/workflows/ci.yml`'s stale `packages/vent-compliance` references (two steps) left over from the
OpenVent rebrand (ADR-019/ADR-020) — the directory has been `packages/openvent-compliance` since then,
meaning CI's compliance-package steps have also been silently misconfigured since that rebrand.

**Consequences:** `bun run typecheck` and `bun run build` are now meaningfully trustworthy for the first
time — any future "verified: tsc clean" claim in this file means something. No functional/runtime
behavior changes beyond the `admin-key-gate.tsx` fetch-instead-of-RPC-client swap and the `dnc.tsx` key
fix, both of which are strictly more correct than before. Worth remembering going forward: after any
multi-file edit, verify with `tsc -b` (not bare `tsc --noEmit` on this project's root config), and
re-grep-verify individual edits landed rather than trusting an edit tool's success response alone —
demonstrated real value this round.

---

## ADR-025 — Multi-user dashboard auth: labeled API keys, not accounts
**Date:** 2026-07-08

**Context:** `ADMIN_API_KEY` (a single shared env-var secret) is fine for a solo operator but has no way
to tell which team member or integration used a key, and no way to revoke one person's access without
rotating the secret for everyone. Explicitly scoped down by the user to labeled API keys, not real
username/password accounts — this is the framework's own operator auth, not a customer-facing product
login system.

**Decision:** New table `adminKeys` (additive): `label`, `keyHash` (SHA-256, not a slow password hash —
these are high-entropy generated tokens with no offline-guessing risk, and a fast hash keeps every
admin-gated request cheap), `createdAt`, `lastUsedAt`, `revokedAt` (soft-delete, keeps an audit trail
instead of a hard row delete). `middleware/admin-auth.ts` checks two paths in order: (1) the legacy
`ADMIN_API_KEY` env var — **this path never goes away**, every existing deployment already has it set;
(2) a labeled key hash lookup. The original "nothing configured → warn and allow" local-dev fallback is
preserved, but now conditioned on *no labeled key ever having been created either* — once an operator
deliberately starts using labeled keys, an unset env var shouldn't silently reopen the gate. New
endpoints `POST/GET /admin-keys` and `DELETE /admin-keys/:id`, all gated by `requireAdminKey` itself
(you need a valid key to create more). New dashboard page `/dashboard/settings` — generate a key, see it
in plaintext exactly once with a copy button, list existing keys with created/last-used timestamps,
revoke.

**Consequences:** No breaking change for any existing deployment — `ADMIN_API_KEY` alone continues to
work exactly as before if an operator never touches the new feature. `hashAdminKey` unit-tested directly
(deterministic, collision-resistant across different inputs, fixed-length output, never leaks the
plaintext); the DB-touching CRUD functions aren't unit-tested against a real database, consistent with
this project's existing pattern for DB-touching code elsewhere. Verified with the (now-actually-working,
see ADR-024) `tsc -b`, `vite build`, and the full test suite.

---

## ADR-026 — Redis-backed session storage: optional, opt-in, async interface either way
**Date:** 2026-07-08

**Context:** `session-store.ts`'s own file header already documented the gap: "process-local state, fine
for single-instance, swap for Redis/DB-backed storage if you scale to multiple instances." The user left
the resourcing call to the agent, with one hard constraint: don't force a new required external
dependency on solo/small-team self-hosters who never need to scale past one instance.

**Decision:** `SessionStore` became an explicit interface (`get`/`set`/`update`/`delete`/`size`, all
async now — Redis I/O can't be synchronous, so the in-memory implementation moved to async too, even
though it doesn't need to be, purely so switching backends is a config change and never a call-site code
change). Two implementations: `MemorySessionStore` (today's exact `Map`-based logic, now behind the
interface, still the default) and `RedisSessionStore` (`ioredis`, one JSON-serialized key per call,
native `PX` TTL instead of the manual sweep interval, `update` reads the remaining TTL and preserves it
rather than resetting the full hour on every small patch like a `captureField` write mid-call). A factory
at module load picks the implementation based on whether `process.env.REDIS_URL` is set — unset, and
behavior is 100% identical to before this ADR, no new dependency actually exercised at runtime. Every
call site across `stream.ts`, `routes.ts`, and `workflows/scheduler.ts` (11 call sites total) needed an
`await` added — all were already inside `async` functions, so mechanically safe, but each one was
verified individually rather than assumed.

**Consequences:** New `ioredis` dependency (only imported/constructed when `REDIS_URL` is actually set).
Docs gained a "Scaling to multiple instances" section in `configuration.md` recommending Upstash's free
tier as the lowest-setup option for anyone who does need this, while being explicit that any
Redis-compatible service works — no vendor lock-in, it's a plain connection string. Verified two ways:
the existing `session-store.test.ts` suite (rewritten for the async interface, still exercises the
default in-memory path, all passing) and a real, temporary local Redis instance
(`apt install redis-server`, since none was otherwise available) — set/get/update-merge/update-preserves-
TTL/size/delete all confirmed working end to end against real Redis, not just inferred from reading the
code, then removed after verification.

## ADR-027 — Docs/landing-page sync after the four-item round
**Date:** 2026-07-08

**Context:** ADR-022, ADR-023, ADR-025, and ADR-026 each shipped code + tests, but the public-facing surface
(landing page roadmap/shipped sections, `README.md`, `docs/*.md`, `.env.example`) still described the
pre-round state — stale "known limitations" bullets claiming in-memory-only session state and a single
shared admin key, `docs/state-engine.md` silent on cross-call memory, `.env.example` missing both
`ADMIN_API_KEY` and `REDIS_URL` entirely. Landing copy said "rolling per-phone-number history," which
overstates what ADR-023 actually built (a merged flat key/value overlay, not a call-by-call log) — fixed to
match.

**Decision:** No code changes. Docs-only round:
- `packages/web/src/web/components/landing/roadmap.tsx` — moved all four items from `next[]` into `done[]`,
  replaced `next[]` with the three items actually still open (hosted DNC/SAN, telephony abstraction, npm
  publish), corrected the cross-call-memory wording.
- `packages/web/src/web/components/landing/shipped.tsx` — added two new cards (latency + cross-call
  memory; multi-user keys + Redis sessions) so the highlighted "Shipped Since Launch" section isn't missing
  the newest work.
- `docs/api-reference.md` — added the three new endpoints (`/calls/:id/latency`, `/calls/:id/audit`,
  `/admin-keys` CRUD) that existed in code but not in the reference table.
- `docs/dashboard.md` — documented the Latency panel, Audit page, and Keys page.
- `docs/state-engine.md` — new "Cross-call memory" section describing `callerMemory`, the merge behavior,
  and the inbound/outbound human-number resolution, cross-referenced to ADR-023.
- `.env.example` — added `ADMIN_API_KEY` (legacy bootstrap path) and `REDIS_URL` (optional, opt-in) with
  inline comments matching their actual runtime behavior.
- `README.md` — fixed the two stale "Known limitations" bullets, added feature bullets for the four shipped
  items, updated the Live link from the old preview URL to `openvent.dev`.
- `ROADMAP.md` — removed two now-stale "Later" bullets (multi-tenant dashboard auth, Redis/DB session
  storage) that the four-item round already shipped; replaced with a narrower "full multi-tenant
  accounts" item reflecting what's actually still open beyond labeled admin keys.

**Consequences:** Verified via `tsc -b --force` (clean), `bun run build` (clean), 55/55 web tests, 25/25
`@openvent/compliance` tests — no code paths touched, so this is a low-risk documentation commit riding on
top of already-verified ADR-022/023/025/026 code.

---

## ADR-028 — Relicense from the Vent Sustainable Use License back to Apache 2.0, protect the name via trademark instead

**Date:** 2026-07-09

**Context:** ADR-018 moved the project from MIT to a fair-code license (Vent/OpenVent Sustainable Use
License) specifically to prevent a cloud provider from hosting the software as a competing managed service
ahead of a future "OpenVent Cloud" paid layer. Since then, the actual near-term priority shifted: the goal
now is making OpenVent genuinely open for outside contribution — real PRs, real community trust, potential
inclusion in ecosystem listings and integrations. A source-available, non-OSI license works against that
goal in practice: it's unfamiliar to most contributors, triggers legal-review friction at companies that
might otherwise adopt or contribute, and signals "the maintainer can restrict this later" even though no
restriction was planned beyond the anti-resale clause. Apache 2.0 is OSI-approved, includes an explicit
patent grant (relevant here — telephony/codec-adjacent code carries more patent surface than typical web
app code), and is the standard choice for infrastructure projects that want real external contribution
(Kubernetes, most CNCF projects) as opposed to projects optimizing to prevent cloud-vendor resale at the
cost of community growth (n8n's actual tradeoff, made deliberately for their situation). At zero external
contributors and zero known forks today — the same condition that made ADR-018 cheap to make — this
reversal is equally cheap: no CLA, no consent needed, one commit.

The anti-competing-hosted-service goal from ADR-018 doesn't fully disappear; it's just solved with a
different mechanism. A permissive code license doesn't protect the *code* from being repackaged, but it was
never really the code that mattered for that concern — it's the name. Someone can already fork any Apache
2.0 project and run it as a service; what they can't do is call it "OpenVent" or use the OpenVent logo while
doing it, without that being a trademark violation. This is the same split Kubernetes, Docker, and (for
their core) Supabase actually rely on: permissive code + trademark control on the brand, not a custom
license restricting the code itself.

**Decision:**
- Replace `LICENSE` with the unmodified, canonical Apache License 2.0 text.
- Add a `NOTICE` file with the copyright line and a pointer to the trademark policy (standard Apache 2.0
  practice for projects that also want to flag trademark terms).
- Add `TRADEMARK.md` — plain-language policy: forking, self-hosting, and even commercial use of the code is
  fully permitted; naming a fork/hosted-service/product "OpenVent" (or confusingly similar) or using the
  logo in a way that implies official status is not, without permission.
- Update `packages/openvent-compliance/package.json`'s `license` field from `"SEE LICENSE IN ../../LICENSE"`
  to `"Apache-2.0"`.
- Update `README.md`'s License section to describe Apache 2.0 + the trademark carve-out, replacing the
  fair-code description.
- Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private vulnerability reporting via
  GitHub Security Advisories) — didn't exist before; table stakes for a project actually asking for outside
  contribution.
- Add `.github/ISSUE_TEMPLATE/` (bug report, feature request, config linking to Discussions) and
  `.github/PULL_REQUEST_TEMPLATE.md` — checklist mirrors the existing expectations already documented in
  `CONTRIBUTING.md` (tests, typecheck, docs-in-same-PR, ADR entries for real decisions) so they're enforced
  at the PR template level, not just prose.
- Add a "Good places to start" section to `CONTRIBUTING.md` and an "Open for contribution" section to
  `ROADMAP.md` listing concrete, scoped items (telephony abstraction, scoped required-field schemas, more
  integrations, local mock mode, docs gaps) that are wanted but not on the maintainer's active queue.

**Consequences:** All code contributed from this commit forward is Apache 2.0 — permissive, commercially
usable by anyone, including as a competing hosted service, which ADR-018 explicitly tried to prevent. That
tradeoff is accepted deliberately: the trademark policy is the actual mechanism protecting the "OpenVent"
name and brand equity now, not the code license. If a genuine premium/hosted layer gets built later (the
"OpenVent Cloud" from ADR-015), it can live as closed-source code calling the open core, or under a
separate license for just that layer — it does not require the core to be non-permissive. No functional
code changes in this round. Anyone relying on the code under the Sustainable Use License terms as it stood
before this commit keeps no different rights either way, since Apache 2.0 grants strictly more.

---

## ADR-029 — Strip Runable-scaffold leftovers: analytics beacon, dead template files, placeholder identifiers

**Date:** 2026-07-09

**Context:** The repo was originally scaffolded from Runable's internal managed-app template, and several
pieces of that scaffolding never got cleaned up as the project turned into a real, independent, public
open-source repo. A pass looking specifically for "things that shouldn't be in a public repo" turned up:

- A **third-party analytics beacon** (`packages/web/vite/plugins/runable-analytics-plugin.ts` +
  `packages/web/public/runable.js`) that a Vite plugin silently injected into every production build,
  sending every visitor's page views to `https://r.lilstts.com/events` (Runable's own collector,
  "onedollarstats" under the hood) with zero disclosure anywhere in the app, privacy policy, or docs. Same
  pattern existed in the mobile shell (`OneDollarStatsProvider` in `packages/mobile/app/_layout.tsx` +
  `packages/mobile/lib/analytics.ts`, `onedollarstats` npm dependency). For a project whose entire pitch is
  "compliance-first, self-hosted, read-the-code-and-trust-it" (TCPA/GDPR/HIPAA positioning throughout the
  landing page and docs), silently phoning a third-party analytics collector on every self-hosted deploy is
  a direct contradiction of the project's own stated values, not just an unused file.
- **`.runable/`** — Runable-platform-internal release-tracking tooling (`validate-releases.ts`,
  `releases.json`, its Zod schema) with no relevance to OpenVent as an independent project; wired into the
  `lint` npm script (`validate:releases`), so it ran on every contributor's machine and in CI for no reason
  a self-hoster or contributor could make sense of.
- **`package.json`'s `name` field** was still literally `"sandbox-app-template"` — the raw scaffold name,
  never renamed to `"openvent"`. Cosmetic, but exactly the kind of thing that undermines trust in a repo
  asking for outside contribution (ADR-028).
- **`.env.template`** — a second, unreferenced env-file template left over from the original scaffold,
  listing unrelated platform env vars (`BETTER_AUTH_SECRET`, `AUTUMN_SECRET_KEY`, `APPLICATION_ID`) that
  don't exist anywhere in OpenVent's actual code. `.env.example` is the real, accurate, already-documented
  one; the second file was pure confusion for anyone setting up a dev environment.
- **`packages/web/website.config.json`** still had `"name": "Runable"` and `"hostname": "xyz.runable.site"`
  — unfilled scaffold placeholders.
- **`packages/mobile/app.json`** had `"package"/"bundleIdentifier": "com.appId.runable"` (a literal,
  never-filled-in template placeholder) and a hardcoded `apiUrl` pointing at a dead internal Runable preview
  URL (`voiceag-1mf8gfp-preview-4200.runable.site`) plus a Runable-internal `applicationId` — none of it
  meaningful outside the original sandbox session it was generated in.
- Two landing-page copy spots (`faq.tsx`, `cta-footer.tsx`) still said "fair-code" / "OpenVent Sustainable
  Use License" after ADR-028 moved the project to Apache 2.0 — the license file changed but two prose
  mentions were missed in that round.

Removing the `.runable/`-wired `validate:releases` step also surfaced that the root `zod`/`semver`/
`@types/semver` devDependencies existed only to support that deleted tooling — `packages/web` already
depends on its own `zod` directly, so nothing else used the root copies.

Deleting the analytics plugin also exposed a latent, unrelated type-checking gap: six files
(`gohighlevel.ts`, `google-calendar.ts`, `hubspot.ts`, `salesforce.ts`, `hono-dev-plugin.ts`) were only
passing `tsc -b` because `jsdom`'s ambient types (pulled in only by the now-deleted plugin importing
`jsdom`) were incidentally providing a looser global `fetch`/`Request`/`Response` type than `bun-types`
actually defines on its own. With that incidental import gone, `tsc -b --force` correctly failed on `.json()`
calls typed as `{}`/`unknown` and a `new Request(url, ...)` call passed a `URL` instead of a `string`. These
were real, pre-existing gaps in the type coverage of those files, just masked by an accidental transitive
import — not something introduced by this cleanup, but only surfaced by it.

**Decision:**
- Delete the analytics plugin, its injected script, and the mobile `OneDollarStatsProvider` wiring +
  `onedollarstats` dependency entirely. No replacement telemetry added — if usage analytics are wanted
  later, they need to be an explicit, disclosed, opt-in choice documented in the privacy-relevant docs, not
  a silent build-time injection.
- Delete `.runable/` and the `validate:releases` step from `package.json`'s `lint` script.
- Rename `package.json`'s `name` to `"openvent"`; drop the now-unused `zod`/`semver`/`@types/semver` root
  devDependencies.
- Delete `.env.template`; `.env.example` remains the single source of truth for env setup.
- Fix `website.config.json` and `packages/mobile/app.json` placeholders to real OpenVent values
  (`dev.openvent.mobile` for bundle/package identifiers, no hardcoded stale preview URL —
  `packages/mobile/lib/api.ts` already falls back to `EXPO_PUBLIC_API_URL` if the Expo config extra is
  empty).
- Fix the two stale "fair-code" mentions in landing-page copy to reflect Apache 2.0.
- Fix the six real type-checking gaps directly (`as any` casts on external API JSON responses in the four
  integration files — these are untyped third-party API bodies by nature, so a cast is the honest
  representation, not a workaround; `url.toString()` in `hono-dev-plugin.ts` so `Request`'s first argument
  matches its actual type; removed the now-unneeded `@ts-expect-error` on `duplex` since the overload
  resolves cleanly once the first argument is a plain string) rather than papering over them or
  reintroducing an incidental `jsdom` import just to keep the previous (accidental) type behavior.

**Consequences:** Verified via `tsc -b --force` (clean, no incremental-cache shortcuts), `vite build`
(clean — confirmed the built `dist/index.html` no longer contains any reference to the analytics script),
`bun run lint`/oxlint (0 warnings/errors), 55/55 web tests, 25/25 `@openvent/compliance` tests. Anyone
self-hosting OpenVent from this commit forward sends zero telemetry anywhere unless they explicitly wire up
their own. `packages/desktop`'s `package.json`/`app` naming (`@template/desktop`, etc.) and the mobile/
desktop packages' internal workspace names (`@template/web`, `@template/mobile`) were deliberately left
alone in this round — those are internal-only workspace package names never published or exposed to end
users, and renaming them touches every cross-package import; not worth the blast radius for a cosmetic-only
concern, unlike the public-facing identifiers and behavior fixed above.

---

## ADR-030 — Fork into a private repo as Weeber's backend, add org-lite scoping + the Shopify vertical (cart recovery, COD confirmation, feedback)

**Date:** 2026-07-09

**Context:** Per the "Weeber's Voice Runtime" decision report (LiveKit vs. Pipecat vs. ElevenLabs Agents vs.
Vent), Weeber's backend is being built on this codebase rather than migrating to an external platform — the
compliance layer here is the actual product differentiator and already exists, tested. This repo (`openvent`,
private) is that fork: same architecture, same compliance package, extended with what Weeber specifically
needs that a generic self-hosted framework doesn't: org scoping and the Shopify vertical's three call flows.

Two scope decisions were made deliberately narrow, on explicit direction, to ship faster:

1. **Full multi-tenant isolation (per-tenant Twilio sub-accounts, per-org DNC lists, per-org billing
   entities, full RBAC/multi-seat accounts) is out of scope for this round.** Individual Shopify merchants
   don't need any of that on day one — one owner login per merchant, one shared pool of Twilio numbers, one
   shared DNC list. What's NOT droppable: basic `orgId` scoping on every table that holds merchant data
   (`calls`, `scheduledCalls`, `shopifyContacts`) — retrofitting that onto an already-single-tenant schema
   later is a materially bigger, riskier migration than building it in now while the tables are new. This is
   the actual scope of "org-lite" throughout this ADR and the schema: enough to never leak Merchant A's data
   into Merchant B's queries, nothing more.
2. **The builder is form-based agent config, not a visual flowchart/canvas.** No visual builder exists in
   this codebase at all today (verified — no flow/canvas component anywhere in `packages/web`); agent
   behavior is currently `AGENT_PERSONAS`/`WORKFLOWS` env-var JSON, code-first, no UI. A form-based config UI
   (persona/tone/tools/KB fields, one per agent) is a smaller build than a node-based canvas and is
   sufficient for three fixed, curated agent templates — a canvas only earns its cost if merchants need to
   design their own conversation branching, which isn't the v1 pitch ("zero merchant setup").

The Shopify vertical's three agents are derived directly from the already-versioned wire contract with the
`weebersh` connector app (github.com/Aurora-091/weebersh, `docs/contract.md` v1.4) — not invented for this
round. That contract already assumes an `org_id` concept (`ShopOrgLink` table on weebersh's side) and defines
exactly which Shopify events exist and what Weeber must do with each: **cart recovery** (checkouts
created/updated), **COD confirmation** (orders placed with a cash-on-delivery/pending-payment gateway), and
**feedback** (orders fulfilled, delayed). weebersh also holds and refreshes the actual Shopify access token
itself — Weeber never touches it directly, only calls back into weebersh's own write-back endpoints
(annotate/cancel/create-discount) authenticated by a separate rotatable secret.

**Decision:**

*Schema (additive only, no renames/drops):*
- `orgs`, `shopLinks` (mirrors weebersh's `ShopOrgLink`, shop -> org lookup), `shopifyContacts` (customer
  upsert target, unique on `(orgId, e164)`), `shopifyDiscountCodes` (idempotency ledger for issued discount
  codes), `shopifyWebhookEvents` (generic idempotency ledger for the at-least-once webhook contract, unique
  on `(shop, topic, idempotencyKey)`).
- `orgId` (nullable text) added to `calls` and `scheduledCalls`; `metadata` (nullable JSON) added to
  `scheduledCalls` for vertical-specific workflow context (e.g. `{ shop, orderId, checkoutToken }`) — generic
  by design so any future vertical/workflow reuses the same column instead of growing the table per feature.

*Core engine changes (small, additive, documented here because they touch shared files, not just new ones):*
- `CallSession` (session-store.ts) gained `orgId`/`workflowMetadata` fields, threaded through
  scheduler.ts -> stream.ts/routes.ts -> `runWorkflowForOutcome` -> engine.ts's retry-insert, so a workflow
  retry chain (e.g. COD confirmation's 3 attempts) keeps its Shopify context on every attempt, not just the
  first. Without this, a retried call would lose track of which `shop`/`orderId` it was calling about.
- `WorkflowAction`'s `retry` variant gained an optional `onExhausted` (`webhook` or `addToDnc`), fired once
  when a retry chain gives up. This is what lets COD confirmation cancel an unconfirmed order after N failed
  attempts (via a webhook back into this repo's own `/internal/cod-confirmation-exhausted` route) without
  putting Shopify-specific logic inside the generic workflow engine — `onExhausted` is a generic "give up
  after N tries, then do X" primitive any future workflow can reuse the same way.
- Both changes are backward compatible: `orgId`/`metadata`/`onExhausted` are all optional, so existing
  self-hosted OpenVent workflow configs and calls with none of this set behave identically to before.

*New module — `packages/web/src/api/integrations/shopify/`:*
- `routes.ts` — all 9 outbound-direction contract endpoints (`/connected`, `/webhooks/checkouts`,
  `/orders/create`, `/orders/fulfilled`, `/webhooks/customers`, `/uninstalled`, `/customers/redact`,
  `/shop/redact`, `/customers/data_request`), each authenticated via `X-Weeber-Secret`
  (`secret-auth.ts`) and idempotency-checked (`idempotency.ts`) per the contract's at-least-once delivery
  guarantee, mounted at `/api/integrations/shopify/*`.
- `client.ts` — the inbound direction (Weeber calling weebersh's `/orders/annotate`, `/orders/cancel`,
  `/discounts/create`), authenticated via the separate `X-Weeber-Callback-Secret`.
- Two new voice tools (`offerCartRecoveryDiscount`, `confirmCodOrder`) following the existing
  `bookAppointment`/CRM-integration tool pattern (real API call inside `execute`, resilient to failure without
  crashing the call). The feedback agent needs no new tool — it reuses the existing generic `captureField`
  tool, since post-delivery feedback is just free-form fact capture, already built.
- All three agents are just `scheduledCalls` rows with a `workflowName` — zero scheduler changes needed
  beyond what's described above; the existing sweep (DNC + calling-window gated) already handles dispatch,
  retries, and now (via `onExhausted`) give-up behavior uniformly.

*Infra (Vercel + Railway + Supabase, per explicit direction):*
- **Vercel** — frontend only (the existing static Vite build, `vercel.json` unchanged). Note: splitting
  frontend (Vercel) from backend (Railway) means the dashboard's fetch calls need an absolute API base URL
  instead of same-origin relative paths — not yet done, flagged as a small mechanical follow-up in
  WEEBER-PLAN.md.
- **Railway** — the backend (Bun/Hono server, Twilio Media Streams WebSocket, the scheduler sweep). Runs
  directly via `bun run start:railway` (new script), deliberately NOT through `pm2`/`ecosystem.config.cjs` —
  Railway's own container supervisor already handles restarts (`railway.json`'s `restartPolicyType`), and
  running pm2 inside a platform-supervised container is redundant and can interfere with graceful
  SIGTERM handling during deploys.
- **Supabase** — Storage (KB PDF uploads, a private `kb-documents` bucket, migration included) and Auth
  (intended to back real merchant login later, replacing labeled admin keys for the merchant-facing
  dashboard specifically — `ADMIN_API_KEY`/`admin_keys` stays as-is for Weeber's own internal ops access) and
  Edge Functions (one example stub, `gdpr-redact-notify`, NOT yet wired to the redact route — a real,
  scoped follow-up, not a hidden gap). **The core relational DB stays on Turso/libSQL** — `drizzle.config.ts`'s
  `dialect: "turso"` is unchanged. Migrating the whole schema to Supabase Postgres was considered and
  rejected for this round: it's a real dialect-level Drizzle migration (`sqliteTable` -> `pgTable`, new
  migration files) with zero functional benefit right now, since Turso already works and nothing here needs
  Postgres-specific features. Supabase is used only where it's genuinely the best tool (Storage, Auth,
  Functions), not adopted wholesale just because it was mentioned.

**Consequences:** This repo can now receive real weebersh traffic end-to-end for all three Shopify call
flows, gated by the same compliance layer (DNC + TCPA calling window) every other call in this codebase
already goes through — no separate, weaker path was created for the Shopify vertical. Known, explicitly
flagged gaps (not silently skipped): checkout-recovery cancellation matches on phone number only, not
`checkout_token` (the token isn't its own indexed column, only inside `scheduledCalls.metadata`); order-value
attribution (marking a recovered call with the order's value) isn't implemented; GDPR erasure for Shopify
contacts is org-scoped but doesn't yet reach into `calls`/`transcripts` (those use the existing, phone-number-
keyed, non-org-scoped erasure path from the base repo); outbound calls for all Shopify agents currently place
from the single global `TWILIO_PHONE_NUMBER`, not a per-org pooled number. Each of these is sized and listed
in `WEEBER-PLAN.md`'s "Phase 2 / immediate follow-ups" section, not left implicit.

---

## ADR-031 — Design system, codebase structure, and vertical-agnostic data model for Weeber's dashboards

**Date:** 2026-07-09

**Context:** Before handing the admin panel + merchant-facing dashboard build off to a team working with
Claude, a round of explicit planning decisions was needed — design system, where the new UI lives in the
codebase, what the two dashboards (internal admin vs. merchant-facing) actually contain, CI strictness,
staging/prod separation, API conventions, auth model, and whether to generalize beyond Shopify now or later.
All decisions below were confirmed by direct answer, not assumed.

**Decisions:**
- **Design system: shadcn/ui + Tailwind.** `packages/web` already had every shadcn prerequisite in place
  (Tailwind v4 CSS-theme setup, `clsx`/`tailwind-merge`/`class-variance-authority`, a `cn()` helper, even
  `tw-animate-css`) except the actual `components.json` manifest — added this round so `bunx shadcn add
  <component>` works cleanly going forward instead of the one hand-copied `button.tsx` that existed before.
- **Merchant dashboard gets its own Weeber-branded skin, same component system** — not a reskin of the
  existing editorial serif/ember OpenVent operator look, and not a from-scratch design system either. No
  final brand assets exist yet, so `CLAUDE-BUILD-BRIEF.md` includes a starting proposal (palette, type) to
  build against now rather than blocking on brand work — swappable later via the same CSS-theme variables
  approach already in `styles.css`, not a rebuild.
- **Both dashboards live in `packages/web`, not a separate package/repo.** The existing operator dashboard
  (`/dashboard/*` — calls, DNC, audit, keys) becomes the foundation of the **internal admin panel**, extended
  with org/shop management, the agent template catalog, billing oversight, compliance/DNC oversight, feature
  flags, and merchant-account impersonation. A new `/app/*` route tree is the **merchant-facing** surface
  (onboarding wizard, agent config, call history/transcripts, analytics, billing, Shopify connection status).
  Splitting these into separate apps was considered and rejected — they share auth plumbing and org-scoped
  data access, and a second app boundary right now is complexity with no present benefit.
- **Impersonation is in scope for v1's admin panel, explicitly audit-logged.** This was flagged as a
  security surface worth deferring; the decision was to keep it in scope anyway, so the requirement is that
  every impersonation action writes an audit entry (who impersonated which org, when, for how long) rather
  than being silently possible — see `CLAUDE-BUILD-BRIEF.md` for the concrete requirement.
- **CI stays strict** — the existing `.github/workflows/ci.yml` (typecheck + test + build + lint, inherited
  from the public OpenVent repo) already matches this; no change needed to the workflow itself. The
  requirement going forward is enabling branch protection on `main` (require the CI check to pass before
  merge) — not yet configured, a GitHub repo setting rather than a file, called out explicitly in
  `CLAUDE-BUILD-BRIEF.md` so it doesn't get missed.
- **Fully separate staging and production infrastructure** — separate Fly/Railway app, separate Supabase
  project, separate Twilio subaccount with test numbers for staging. Decided now specifically because it's
  cheap before real merchant data exists and expensive to retrofit after.
- **New backend endpoints follow this repo's existing conventions exactly** — the `resilientCall` wrapper for
  external API calls, the adapter pattern for storage (see `compliance/adapters.ts`), the idempotency-ledger
  pattern (`integrations/shopify/idempotency.ts`) for any future webhook-driven integration, and the
  `requireAdminKey`/`requireWeeberSecret` middleware style for auth. Chosen over giving free discretion per
  endpoint specifically to avoid ending up maintaining two different code styles in one repo.
- **Merchant auth: Supabase Auth (email/password + magic link).** Already scaffolded (`supabase/config.toml`,
  ADR-030) but not wired to any route yet. `ADMIN_API_KEY`/`admin_keys` stays completely untouched — that
  path is for Weeber's own internal ops access, never merchant-facing.
- **Vertical-agnostic data model now, Shopify-only UI for now.** `orgs` gained a `vertical` column (text,
  default `"shopify"`, not DB-enum-constrained — a new vertical shouldn't need a migration to exist). New
  `agentTemplates` table (vertical, stable `key`, name, default persona prompt, default tool list, active
  flag) is the seed of the admin panel's "agent template catalog" and the concrete mechanism a future
  Clinic/Hotel vertical plugs into — new rows, not new schema.

**Consequences:** `components.json` and the two schema additions (`orgs.vertical`, `agentTemplates`) are
additive-only and verified via `tsc -b --force` (clean). No UI was built in this round — per direction, the
actual admin-panel and merchant-dashboard construction is Claude's build, not this pass; this ADR and
`CLAUDE-BUILD-BRIEF.md` are the spec it builds against. The impersonation audit-log requirement is a
commitment made here that the build must satisfy, not an implemented feature yet.

---

## ADR-032 — Weeber product design system: Arc-like warm paper theme, confirmed by explicit UI/UX round

**Date:** 2026-07-09

**Context:** Before Claude/the team start building the admin panel and merchant dashboard pages (scoped in
ADR-031/`CLAUDE-BUILD-BRIEF.md`), a dedicated round of visual-direction questions was needed — the request
was specifically for a "paper-like, black and grey" SOTA look, which is vague enough to mean several very
different things (Linear's stark monochrome density vs. Arc's warm calm paper vs. a literal textured-paper
skeuomorphism). Sixteen explicit questions were answered covering reference point, exact color rules, theme
parity, typography, component shape, density, animation, loading/empty states, navigation, onboarding
pattern, responsiveness, and accessibility bar — several answers overrode my initial recommendation, and
those overrides are followed exactly, not softened.

**Decision:** Full spec lives in `UI-DESIGN-BRIEF.md` — summarized:
- **Arc browser** is the confirmed reference (warm, calm, paper-like), not Linear's stark monochrome density
  (my initial suggestion, correctly overridden).
- **Grayscale + a full semantic set** (red/green/amber) **+ one brand accent** (indigo/violet, `oklch(0.53
  0.19 275)`) — not the stricter "grayscale + one accent only" I'd suggested; the semantic trio was judged
  necessary for scanning status at a glance in a compliance-driven ops tool, which was actually my own
  original reasoning for suggesting an accent at all — the answer just extended that reasoning further than
  I initially proposed.
- **Full light/dark parity from day one**, not light-first-with-dark-later.
- **Serif (Fraunces) for headings, sans (Inter Tight) for everything else** — keeping one deliberate echo of
  the landing page's editorial identity, rather than an all-sans direction.
- **Moderate rounding (10px)**, not the sharper 2-4px I'd suggested.
- **Mixed surface treatment** — flat bordered inline content, shadow-elevated overlays (modals/popovers) —
  not "flat everywhere."
- **Different density per audience** (dense admin panel, spacious merchant dashboard) sharing one component
  system — this one matched my recommendation exactly.
- **Tasteful 200-400ms micro-interactions**, not the near-invisible utilitarian timing I'd suggested — but
  **instant page/route transitions** either way, which isn't a contradiction: within-page polish, zero
  between-page latency.
- **Skeleton loading, minimal text-only empty/error states, left sidebar + command palette navigation,
  multi-step onboarding wizard with progress indicator, desktop-first responsiveness** — all matched my
  recommendation.
- **WCAG AA compliance required for v1**, upgraded from my initial "best-effort" suggestion to an actual
  build requirement.

Implemented this round: a `.theme-weeber`/`.theme-weeber.dark` CSS class in `packages/web/src/web/
styles.css` with the full token set (background, ink, border, brand accent, semantic colors, radius) for
both light and dark modes — additive, scoped, and deliberately separate from the existing `:root`/`.dark`
tokens that belong to the public OpenVent landing page (untouched, unrelated surface). Every `/dashboard`
and `/app` route should apply `.theme-weeber` at its root layout element.

**Consequences:** Verified via `vite build` (clean, CSS output grew from 41.50kB to 44.49kB as expected for
the new token block, no errors). No components or pages were built this round — this ADR and
`UI-DESIGN-BRIEF.md` are the spec Claude/the team builds against, matching the same "decide the seam now,
build the feature later" pattern as ADR-030/031's schema work. Exact spacing-scale values, the logo/wordmark,
and the command palette's action list remain open, flagged explicitly in `UI-DESIGN-BRIEF.md`'s closing
section rather than guessed at.

---

## ADR-033 — Klaviyo/Shopify Flow research: identified a real gap (entry-condition branching), generalized beyond Shopify

**Date:** 2026-07-09

**Context:** Request was to study how Shopify-ecosystem email marketing tools (Klaviyo, Shopify Flow) let
merchants build if/else + retry automation for abandoned-cart flows, and whether that pattern should extend
to every Weeber agent, not just cart recovery. Researched both:

- **Klaviyo's flow model:** trigger (event) → **trigger split** (branches on event-level data, e.g. cart
  value, only available on event-triggered flows) and/or **conditional split** (branches on profile/history
  data, e.g. first-time vs. repeat customer, usable anywhere) → time delays (placement before/after a split
  changes the semantics) → messages. Splits produce parallel YES/NO paths on a visual canvas.
- **Shopify Flow's model:** the same shape, more generic — Trigger → Condition → Action, 100+ built-in
  triggers, a "Wait" action for delays, drag-and-drop canvas.

Mapped both against what already exists in this repo's workflow engine (`voice/workflows/`):

| Concept | Status here |
|---|---|
| Time delay | `scheduledCalls.runAt` — exists |
| Retry with a cap | `WorkflowAction`'s `retry` — exists |
| Give-up-after-N-tries action | `onExhausted` (ADR-030) — exists, already generic, not Shopify-specific |
| Action (webhook/DNC/SMS) | exists |
| Branch on how a call **ended** | `onOutcome` — exists |
| **Branch on conditions at flow entry** (Klaviyo's "trigger split" — e.g. cart value, customer segment, before the first action even happens) | **Does not exist** |
| Merchant-visual editing of any of this | **Does not exist** — env-var JSON, code-first |

**Decision:** The gap is real and worth closing — entry-condition branching, generalized across every
agent/vertical, not hardcoded Shopify cart-value logic. This does **not** reopen the earlier form-vs-canvas
decision (ADR-030/031's "form-based agent config, not a visual builder" was about *persona/tone/tools*
config, which stays a form) — it refines it: Klaviyo itself keeps email *content* in an ordinary editor while
the flow *logic* (trigger/condition/delay/action graph) is the visual canvas. The automation-trigger layer is
inherently graph-shaped in a way a flat form represents poorly; the persona-content layer isn't.
**Sequencing, not scope, was the call made here:** build the branching capability itself first (config-
driven, same pattern as today's `WORKFLOWS` env var or wherever the config-storage migration lands), and
treat a visual canvas (React Flow — MIT-licensed, the standard library underlying most n8n/Zapier-style
builders) as a legitimate, separate follow-up once the underlying engine capability actually works. Sized in
`WEEBER-PLAN.md`'s Phase 2 list, not built this round — explicitly flagged as a decision for the user to
confirm before starting (config-only vs. visual-canvas-from-day-one), not decided unilaterally here.

**Consequences:** No code changed this round — this ADR and the `WEEBER-PLAN.md` entry are the spec for a
future workstream. The generalization point matters for `agentTemplates` (ADR-031): whatever
`entryConditions` shape gets built should read from that same vertical-agnostic seam, not a Shopify-specific
one, so Clinic/Hotel agents get the same branching capability without a second implementation later.

---

## ADR-034 — Stack finalization: Supabase Postgres as the primary DB, Railway + Vercel confirmed, Razorpay-first billing (India GTM)

**Date:** 2026-07-10

**Context:** Three items from `CLAUDE.md`'s STOP-AND-ASK gate list (hosting platform, payment gateway) plus
the Turso-vs-Postgres question raised in the post-cleanup stack review were resolved by explicit user
direction in one round. The stack review's core argument on the database: ADR-030 kept Turso/libSQL because
migrating had "zero functional benefit right now" — true for the MVP fork, but Weeber is now a startup whose
Phase 2 roadmap (per-org DNC lists, per-org billing entities, RBAC) is exactly the relational multi-tenant
modeling Postgres is built for, Supabase is already in the stack for Auth/Storage/Functions (so this
*removes* a database rather than adding one), and Postgres row-level security can enforce org isolation at
the database layer instead of relying on `WHERE orgId = ?` discipline in every query. Same asymmetric-cost
logic ADR-030 itself used for `orgId` scoping: cheap before real merchant data exists, expensive to
retrofit after.

**Decision:**

1. **Supabase Postgres is the primary relational DB, from the start — supersedes ADR-030's "core DB stays
   on Turso" call.** The full Drizzle schema migrates `sqliteTable` → `pgTable` (`dialect: "turso"` →
   `"postgresql"` in `drizzle.config.ts`), and Supabase is used to its full extent: Postgres (+ RLS for
   org scoping), Auth (merchant login, per ADR-031), Storage (KB documents), Edge Functions, and whatever
   else earns its place (Realtime for live call status on the dashboard is a natural candidate, not
   committed). No data migration burden exists yet — no production merchant data is in Turso — which is
   precisely why now. **Blocked on:** the Supabase project itself does not exist yet; create it first, then
   the schema migration is a normal workstream (sized in `WEEBER-PLAN.md`).
2. **Hosting: Railway for the backend, Vercel for the frontend — resolves STOP-AND-ASK #3.** Fly.io's HIPAA
   BAA argument is moot for now: first vertical is Shopify (India GTM), not clinics. `railway.json` stands.
   Both platforms' official MCP servers are wired into `.mcp.json` (`railway` via `@railway/mcp-server` +
   `RAILWAY_API_TOKEN` env var; `vercel` via the hosted HTTP MCP at `mcp.vercel.com`, OAuth at connect
   time). `vercel.json` — deleted in error during the OSS cleanup on the assumption it existed only for the
   OpenVent marketing site — is restored: it is the production deploy config for the dashboard frontend.
3. **Payments: Razorpay first — resolves STOP-AND-ASK #5, with a sequencing twist.** First GTM is
   India-based, which is exactly the market Razorpay is strongest in; Dodo Payments (Merchant-of-Record,
   cross-border tax handling) is the planned addition **when** international expansion happens — a "when,"
   not an "if," per explicit direction ("we are going global too"). Consequence for the billing
   integration whenever it's built: put a thin gateway abstraction in front (same provider-seam pattern as
   LLM/TTS), so adding Dodo later is an adapter, not a rework. Do not build the Dodo adapter now.

**Consequences:** The Turso → Supabase Postgres migration becomes the top structural workstream and should
land **before** merchant-facing features build up more schema surface on the SQLite dialect. `db:push`
against Turso remains the working reality until that lands — every doc reference to Turso/libSQL is
accurate-but-terminal. The `@tursodatabase/api` and `@libsql/client` dependencies go away with the
migration. Env surface changes: `DATABASE_URL` will point at Supabase Postgres (pooled connection string),
and `RAILWAY_API_TOKEN` joins the shell-env list for MCP use. India-first GTM also means the TCPA
calling-window/DNC model (US-centric, NANP area codes) needs an India-aware compliance review — TRAI's
DND registry and calling-hour norms are a different regime; flagged as a required follow-up in
`WEEBER-PLAN.md`, not silently assumed equivalent.

---

## ADR-035 — Backend separation: prepare the seam now, split later

**Date:** 2026-07-10

**Context:** Explicit user direction: separating the backend into its own unit will pay off in the future
but not now — start preparing for it. Today `packages/web` is one package holding both the Hono API
(`src/api`) and the React dashboard (`src/web`), served by one Bun process in the single-deploy story but
already deployed as two artifacts in production (Railway runs the full server; Vercel serves only the
static frontend build). An audit of the actual coupling found it small: exactly one frontend→backend
import, and it's type-only (`AppType` for the Hono RPC client — erased at build time, survives any split
as a package-name change); the real coupling was that every API call assumed same-origin (`hc("/")` plus
three raw `fetch("/api/...")` call sites).

**Decision:** Do not split into separate packages/repos yet — build and enforce the seam so the eventual
split is mechanical:

1. **`src/web/lib/api.ts` is the single point of contact with the backend's location.** It reads
   `VITE_API_BASE_URL` (build-time, Vite): unset = same-origin (single-deploy, today's default), set = all
   API traffic targets that origin. It exports the typed RPC client (`api`), plus `apiFetch`/`apiUrl` for
   the few raw-HTTP call sites (status checks, text/blob downloads). **Boundary rule from now on: frontend
   code never calls global `fetch` with a hardcoded `/api/...` path, and never imports anything from
   `src/api` except types.** All three existing raw call sites were migrated.
2. **CORS allowlist, env-gated:** `CORS_ALLOWED_ORIGINS` (comma-separated) on the backend. Unset preserves
   the previous reflect-any-origin behavior (acceptable while auth is header-based, no cookies); it must be
   set to the real dashboard origin(s) before the Vercel frontend goes live on a real domain.
3. **The future split shape**, when it earns its cost (own release cadence, separate teams, or backend
   reuse by a non-dashboard client): `src/api` moves to a `packages/api` workspace package (or its own
   repo), the frontend's `AppType` import becomes a package import, and nothing else changes — that's the
   point of the seam. Not scheduled; revisit when one of those triggers is actually true.

Also this round: the `railway` MCP entry corrected to Railway's hosted HTTP MCP (`mcp.railway.com/mcp`,
OAuth on connect — same pattern as Vercel's), replacing the stdio/`RAILWAY_API_TOKEN` wiring from earlier
in the day.

**Consequences:** Workstream E's code half (WEEBER-PLAN) is done ahead of the Vercel deploy — what remains
is setting `VITE_API_BASE_URL` in Vercel's build env and `CORS_ALLOWED_ORIGINS` on Railway once real URLs
exist. `RAILWAY_API_TOKEN` is no longer needed for MCP use.

---

## ADR-036 — Backend split executed: `packages/api` (@weeber/api) + `packages/web` (@weeber/web)

**Date:** 2026-07-10

**Context:** ADR-035 built the seam and deferred the physical split until a trigger arrived. The user then
decided to do it immediately — "both times we have to spend time, so go for it now" — reasoning that the
mechanical cost is the same today as later, and today the seam is fresh. Fair: the split was several hours
either way, and doing it with zero production traffic removes all deploy risk.

**Decision:** `packages/web/src/api` + `src/server.ts` + `drizzle.config.ts` moved (via `git mv`, history
preserved) into a new **`packages/api`** workspace package, `@weeber/api`:

- **`@weeber/api`** owns everything server-side: the Hono app (`src/index.ts`, exports `AppType`), the Bun
  server entry (`src/server.ts` — Twilio Media Stream WebSocket, boot checks, sweeps), the Drizzle schema +
  config, all voice/integration/database code, and all backend tests (`bun test src/`). Backend deps
  (drizzle, twilio, ai/groq, ioredis, ws, libsql, @openvent/compliance) moved here.
- **`@weeber/web`** (renamed from `@template/web`) is frontend-only: React dashboard, Vite build. It keeps
  `hono` (for `hono/client`) and gains `"@weeber/api": "workspace:*"` — used exclusively for the type-only
  `AppType` import in `lib/api.ts`. The package-level `exports` map (which used to export the API from the
  web package — the tell that the boundary was inverted) moved to `@weeber/api` where it belongs.
- **Single-deploy still works:** `@weeber/api`'s server serves the frontend's built assets from the sibling
  package (`../../web/dist` relative to `src/`) when they exist — `bun run start` (PM2) behaves exactly as
  before. In the split deploy the dist simply never exists on Railway and only `/api/*` + the WebSocket
  matter there.
- **Vite dev `/api` proxying preserved:** `hono-dev-plugin` now loads the Hono app cross-package via
  `/@fs/`-prefixed `ssrLoadModule` — dashboard dev experience unchanged.
- **Config/CI updates:** `ecosystem.config.cjs` + root `start:railway` point at `packages/api/src/server.ts`;
  CI typechecks all three packages and runs the api + compliance test suites; `db:*` scripts live in
  `packages/api` now.

**Consequences:** The repo now has three packages with one-directional dependencies:
`web → api (types only) → compliance`. Backend work and frontend work no longer share a `package.json`,
which is the future-proofing the user asked for — a separate backend repo, if ever wanted, is now a
`git filter-repo` away rather than a refactor. Costs accepted: `bun install` must be re-run (lockfile
changes), and anyone's muscle memory of `cd packages/web && bun run test` must become `packages/api`.
`docs/architecture.md`'s "where things live" tree predates this and reads `packages/web/src/api` — the
`docs/` folder is deliberately unmodified (user direction), so treat `CLAUDE.md`'s tree as current.

---

## ADR-037 — Phase 2 merged into Phase 1: one backlog, sequencing and gates preserved

**Date:** 2026-07-10

**Context:** ADR-030 deliberately split the build into a narrow Phase 1 ("org-lite, one shared Twilio
number pool, no heavy multi-tenant — ship faster") and an explicitly deferred Phase 2. With Phase 1's
infrastructure workstreams now essentially done in one day (backend split, Postgres migration applied to a
live Mumbai project, Railway production deployed and verified end-to-end including the Twilio WebSocket
path, all provider keys armed, persona prompts written), the user asked whether Phase 2 should fold into
Phase 1. Presented options: selective merge (cheap correctness items + per-org caller ID, ~2 weeks) vs.
full merge (~2-3 months of backend surface) vs. keep the split. **User chose full merge.**

**Decision:** There is no Phase 2. All former Phase-2 items are Phase-1 workstreams (WEEBER-PLAN.md
J through S): checkout-token cancellation matching, order-value attribution, org-scoped GDPR erasure,
gdpr-redact-notify wiring, per-org outbound caller ID, per-tenant Twilio sub-accounts/BYO provisioning,
per-org DNC lists, full RBAC/multi-seat, per-org CRM connections (Nango), and entry-condition branching.

What the merge does **not** change:

1. **Sequencing intelligence survives.** Cheap/correctness items (J-N) are unblocked and parallel-friendly;
   heavy multi-tenant items (O, P, Q) still build on their prerequisites (N's number seam, the India
   compliance model, frontend-round auth). Merging the backlog is not permission to build sub-accounts
   before a single merchant exists — it means nothing is "out of scope," not that everything is first.
2. **The gates survive.** Anything touching `packages/openvent-compliance` (P, and I's enforcement half)
   still requires user confirmation before merging (CLAUDE.md gate #6). The trigger-split
   config-vs-canvas question (S) is still an explicit ask-first decision (gate #4).
3. **Backend-before-frontend survives** (explicit user direction from this same session): E (Vercel
   deploy) and Q (RBAC on Supabase Auth) sit in the frontend round.

**Consequences:** CLAUDE.md's STOP-AND-ASK item #8 (which said per-org sub-accounts / per-org DNC / RBAC /
per-org billing are "explicitly deferred — a task requiring one is a signal to check scope") is rewritten:
these are now in scope, and the signal to check is *sequencing* (dependencies above), not scope. The
"Org-lite, not full multi-tenant" architecture note remains accurate as a description of what exists today;
it stops being accurate as a boundary on what gets built.

---

## ADR-038 — India telephony: Exotel over Twilio, and the number-series reality

**Date:** 2026-07-10

**Context:** Twilio doesn't serve India well — it routes Indian calls through international interconnect
rather than being a licensed Indian telecom operator, which combined with TRAI's DLT/number-series
requirements means real compliance overhead and unreliable answer rates at volume. Research identified
**Exotel** as the Indian-native alternative purpose-built for AI voice agents (AgentStream real-time
streaming API, sub-20ms media latency, a published LiveKit reference architecture), with **Ozonetel** as a
credible second option. Separately, a test call placed through a competitor (Bolna) showed caller ID as a
normal 10-digit number, prompting the question of whether Weeber's own (non-marketing) agents could use
one too.

**Decision:**
1. **Exotel is the recommended India telephony provider**, full reasoning and integration notes in the new
   `docs/india-telephony.md`. Not yet integrated or tested — this is a research/recommendation round, not
   an implementation.
2. **Real catch, documented not glossed over:** Exotel's AI-agent path is SIP-trunk-based, bridged into
   LiveKit — not a drop-in replacement for the Twilio Media Streams WebSocket protocol
   `packages/api/src/voice/stream.ts` is built against. The realistic integration shape is a self-hosted
   LiveKit SIP bridge fronting the existing compliance/orchestration/agent code for the India telephony
   path specifically — prototype this end-to-end before treating it as a simple provider swap.
3. **TRAI number-series rules apply to transactional/service calls, not just promotional ones** — this is
   the actual finding worth acting on. 140-series is mandatory for promotional calls (Cart Recovery);
   160/1600-series is mandatory for transactional/service calls (COD Confirmation, Feedback). Regulation
   text explicitly bars "any other 10-digit fixed line/mobile number" for **any** of promotional, service,
   or transactional calls. **Weeber likely needs two different registered number types**, not one shared
   number across all three agents. A normal-looking number working in a competitor's test call is not
   evidence of compliance — TRAI regulation and TRAI enforcement run on different timelines in India, and
   building around "it worked once" is a real, cheap-now-expensive-later risk.
4. **"Twilio sub-account for India" is not the same shape of problem.** Twilio sub-account creation is one
   API call; Indian number provisioning requires DLT Principal Entity registration (business KYC, not an
   API call), Sender ID/header registration, per-call-script Template ID pre-approval, and region/city-scoped
   number KYC with real turnaround time (Exotel's own stated SLA: up to 24 working hours to flag a stuck
   approval). Whether Weeber registers as one Principal Entity (merchants as sub-brands underneath) or each
   merchant registers their own PE is a real, undecided business/liability question — not assumed either
   way in this ADR.

**Consequences:** The "zero setup" onboarding pitch needs an honest design accounting for a KYC/approval
step for at least the first merchant and per-agent-script template approval thereafter — not a promise of
instant provisioning. No code changed this round; `docs/india-telephony.md` is the reference for whoever
scopes the actual Exotel/LiveKit integration and the number-provisioning product flow next.

---

## ADR-039 — Weeber product theme recolored: dark, fully monochrome (overrides ADR-032)

**Decision:** `.theme-weeber` (scoped to `/dashboard` admin panel and `/app` merchant portal only — the
public OSS landing page is untouched) is now dark-by-default and fully monochrome: near-black background,
light-grey foreground, zero brand/accent hue anywhere, including primary buttons and the active-nav state
(those render as an inverted light-grey/white-on-black treatment instead of a color). This replaces
ADR-032's confirmed round (warm off-white paper background + a distinct indigo/violet brand accent).

**Context:** User request, explicit and direct: replace the brown/ember-adjacent warm palette with
black-and-grey, "the full thing." Confirmed via follow-up: dark by default (not a light/dark toggle
defaulting to dark — just dark), fully monochrome including primary/CTA/active-nav (the stricter of two
offered options), applied to both `/dashboard` and `/app` (not just one surface).

**One deliberate exception, flagged rather than silently decided:** the semantic error/success/warning set
stays as distinct hues (kept the same lightness/chroma shape as before, just re-tuned for a dark
background) rather than going fully grayscale too — a DNC/guardrail/call-outcome alert needs to be
scannable at a glance, and "everything is the same grey" would defeat that for a compliance-adjacent
product. If the user actually wants zero color anywhere including status indicators, that's a quick
follow-up change to the same CSS block, not a re-architecture.

**Consequences:** `packages/web/src/web/styles.css`'s `.theme-weeber` block rewritten — same variable
names/structure as ADR-032 (background/foreground/card/primary/etc. all still map through
`--weeber-*` tokens), only the actual OKLCH values changed to chroma-0 (grayscale) except the three status
colors. No component code changed — every dashboard/app page already read through the CSS variables
(`bg-background`, `text-foreground`, `bg-primary`, etc.) rather than hardcoded colors, so the recolor was a
single-file change. Verified visually (screenshot) on both the admin-key-gate screen (`/dashboard`) and the
merchant login screen (`/app/login`) — both render correctly as near-black/monochrome. The existing
light/dark toggle scaffold (`lib/theme.ts`, `theme-toggle.tsx`) is unchanged and still harmless-but-inert
(no `.theme-weeber.dark`-specific rule exists, same as before this round — toggling doesn't currently do
anything either way, pre-existing gap, not introduced or worsened here).

---

## ADR-040 — Configurable per-agent language + multi-provider STT/TTS (Sarvam added)

**Date:** 2026-07-10

**Context:** India has far more languages than any single voice-AI vendor covers well. The voice
pipeline had two hardcoded providers with no language knob at all: Deepgram STT connected with no
`language` param (silently English-only — root cause of a live test call where the agent couldn't
understand Hindi speech at all, not a persona/prompt issue), and TTS already had a clean
`elevenlabs`/`cartesia` provider abstraction (`tts/`) but no third, Indian-language-native option.

**Decision:** Added Sarvam (Saaras v3 STT, Bulbul v3 TTS) as a third provider on both sides, and made
`sttProvider` + `language` first-class fields on the agent frame (`agent-frame.ts`), independent knobs —
STT and TTS providers don't have to be the same vendor (e.g. Deepgram STT + Sarvam TTS for a
Hindi-first agent is a valid combination). Deepgram stays the STT default, Cartesia stays the TTS
default — zero behavior change for every existing deployment that hasn't set a language.

Mirrored the existing TTS provider-registry pattern (`tts/index.ts`) for STT: new `stt/` directory
(`types.ts`, `index.ts`, `deepgram.ts` moved from the old top-level `voice/deepgram.ts`, `sarvam.ts`
new). `language` is stored as plain ISO 639-1 (no region suffix, e.g. `"hi"` not `"hi-IN"`) at the
frame level — each provider adapter normalizes into whatever format it actually needs
(`toSarvamLanguageCode` in both `stt/sarvam.ts` and `tts/sarvam.ts`; Deepgram takes the bare code or
omits the param for English/unset). `"multi"` is Deepgram's own English+auto-detected-other
code-switching mode — STT-only, no Sarvam equivalent.

Sarvam's STT input only accepts wav/PCM, never mu-law (checked against docs.sarvam.ai directly) —
added `voice/audio-codec.ts` (dependency-free G.711 mu-law decode + WAV framing) purely for that one
path. Sarvam's TTS output, by contrast, supports `output_audio_codec: "mulaw"` directly, so that side
needs zero conversion — same zero-re-encoding path as ElevenLabs/Cartesia.

**Architecture correction made alongside this:** STT connection used to happen eagerly in
`stream.ts`'s `onOpen` (fires immediately on WebSocket open), before the Twilio "start" event's async
agent-config lookup resolves `language`/`sttProvider` — so per-call language could never have actually
been threaded through even with the field added. Moved the STT connect call into the "start" handler,
after `resolveAgentConfig` resolves overrides, with a small bounded buffer (`pendingAudioChunks`) so
audio arriving in the (typically tens-of-ms) window before that connects isn't dropped.

Added `sttProvider` (text, nullable, additive) to `org_agent_configs` — migration
`0007_far_arclight.sql`. Dashboard (`/dashboard/agents`) and merchant (`/app/agents`) forms both
updated: voice-provider select gained a `sarvam` option, new STT-provider select, language input
gained a `<datalist>` of curated Indian-language suggestions while staying free text.

**Consequences:** Every existing call is unaffected (no language set -> Deepgram default English,
Cartesia default voice, unchanged). Sarvam requires `SARVAM_API_KEY` (shared across both STT and TTS
uses) — not yet set in any environment; `config-check.ts` only warns at boot if the *global default*
provider is Sarvam and the key is missing, same as the existing ElevenLabs/Cartesia pattern, so this
doesn't block deploys where Sarvam is only used as a per-org override. GTM/marketing-analytics reuse
from Vocalist and the rest of the admin-panel rebuild (ADR-036 onward) are unrelated, separate work —
not touched here.

---

## ADR-041 — Supabase auth: signup confirmation (link + OTP) + password reset; full waitlist referral system ported from Vocalist

**Date:** 2026-07-10

**Context — auth:** The merchant login page already had password signin/signup and magic-link
signin, but password signup had a real bug: `supabase.auth.signUp()` returning no session (because
the Supabase project requires email confirmation) was being treated identically to a successful
signup — it navigated to `/app` with no session at all, a broken redirect. There was also no
password-reset flow.

**Decision — auth:** Added a `needs-confirmation` state to the login page for that no-session-after-
signup case, offering both confirmation paths at once (click the emailed link — same
`/app/auth/callback` handler already used for magic links, since Supabase's `detectSessionInUrl`
consumes both token types the same way — or type the 6-digit code inline via
`supabase.auth.verifyOtp({type:"signup"})`), plus a resend action
(`supabase.auth.resend({type:"signup"})`). Added a full forgot-password flow: "Forgot password?" on
the login page -> `resetPasswordForEmail()` -> new `/app/auth/reset-password` page (same
recovery-token-in-URL mechanism, listens for the `PASSWORD_RECOVERY` auth event) ->
`supabase.auth.updateUser({password})`. No backend changes needed — Supabase sends these emails
itself via the project's own email configuration, not Resend (Resend is earmarked for waitlist
emails specifically, a separate, later piece of work per explicit product decision this session).

**Context — waitlist:** The landing page's waitlist form was a bare email-only capture with no
referral mechanism at all. Vocalist (the older Weeber webapp, `github.com/Aurora-091/Vocalist`) has
a full referral system on its waitlist — explicitly approved for direct content/logic reference and
adaptation this session (not a blanket exception to the advisor-only rule on that repo, which still
holds for actual engineering work on Vocalist itself).

**Decision — waitlist:** Ported the full referral mechanic — not the Vocalist files verbatim (that
repo runs Express + raw `ws` + Supabase edge functions on a different design system entirely), but
the mechanic and copy, rebuilt on openvent's own stack (Hono + Drizzle/Postgres + Bun's native
WebSocket, dark-monochrome theme from ADR-039):
- `waitlist_signups` gains `ownReferralCode` (unique, generated per signup — every join gets an
  immediately shareable link), `referralCount` (atomic SQL increment, not read-then-write, to avoid
  losing concurrent referrals to a race), `phone` (optional post-signup follow-up), `unsubscribed` +
  `unsubscribeToken` (separate from the referral code on purpose — a shareable code and an
  unsubscribe credential shouldn't be the same string). Migration `0008_last_shockwave.sql`,
  additive.
- `WAITLIST_DISPLAY_OFFSET` (40) is a vanity display number, same choice Vocalist made (its
  equivalent was 43) — not a real prior-signup count, just avoids "you're signup #1" undercutting the
  "first 100 lock in founder pricing" framing on a fresh list.
- Live count: a second raw Bun WebSocket path (`/api/public/waitlist/ws`), broadcasting on every new
  join. `Bun.serve` takes exactly one `websocket` handler object for the whole server, so this and
  the existing Twilio Media Stream socket (`voice/ws-route.ts`) now share that one object in
  `server.ts`, dispatched by a `data.kind` discriminant (`"voice"` | `"waitlist"`) — each upgrade
  path tags its own socket data, `server.ts` just routes by kind. `GET /api/public/waitlist/count`
  exists as the HTTP fallback for first paint before the socket connects.
- Unsubscribe is a plain HTML response (`GET /api/public/waitlist/unsubscribe?token=`), not a React
  route — it's meant to be opened directly from an email link, no frontend involvement needed.
- Frontend: landing page's waitlist section replaced entirely (not a separate `/waitlist` route, per
  explicit direction) — name+email form, `?ref=` capture on mount, a success dialog with
  position/count, optional phone capture, and the referral link with copy + native share.
  `useWaitlistCount.ts` mirrors Vocalist's reconnect-with-backoff hook, adapted to this repo's
  `API_BASE_URL` seam (ADR-035) instead of a separate `VITE_WS_HOST`.
- Admin `/dashboard/waitlist` gained columns for the new fields (referred-by code, own code,
  referral count, phone, unsubscribed status).

**Consequences:** No existing signups affected (all new columns nullable/defaulted). The WS
dispatch-by-kind change in `server.ts` means any *third* future raw-socket use case follows the same
pattern (tag socket data, add one more `else if` branch) rather than fighting Bun's single-handler
constraint again. Verified: api tsc + 130/130 tests, web tsc + tests + build, openvent-compliance
tsc + 25/25 tests, root lint — all clean.

---

## ADR-042 — Per-org Twilio isolation: real sub-accounts + BYO (SID + auth token + number)

**Date:** 2026-07-10

**Context:** ADR-030 explicitly deferred this — "no per-org Twilio sub-account... see
WEEBER-PLAN.md Phase 2 for what's deferred." Every org's calls ran through one shared platform
Twilio account (global `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), fine for a single-tenant/
self-hosted deployment but wrong for the multi-tenant product: no per-merchant Twilio billing/usage
isolation, and a merchant who already owns a Twilio account had no way to use it instead of the
platform's.

**Decision:** Added two real per-org Twilio modes, stored on `orgs.twilioMode` ("platform"|"byo",
default "platform" — every existing org keeps today's exact behavior, riding the global env
credentials, until an admin explicitly provisions something):
- **Platform sub-account:** the parent Twilio account (global env credentials) creates a real Twilio
  sub-account via the Accounts API (`twilioClient.api.v2010.accounts.create`); that sub-account's own
  SID + auth token get stored on the org row. Buying a number for it is a separate step
  (`buyNumberForOrg`) using a client scoped to the *sub-account's own* credentials — Twilio requires
  this, a sub-account's numbers can't be bought by the parent on its behalf.
- **BYO:** merchant pastes their own Account SID + Auth Token + existing number. Validated against
  Twilio's own API (`accounts(sid).fetch()`, checked for `status === "active"`) before anything is
  persisted — a bad credential fails immediately here, not on the first real call three steps later.
- Both modes reuse the existing `orgs.outboundNumber` column for the phone number — no new column
  needed there.

`getTwilioClientForOrg(orgId)` (voice/twilio-client.ts) resolves the right client per call — org's
own credentials if configured, else the platform default — with a DB lookup on every call rather than
a cache, since a stale cached client after a credential rotation would silently keep using a revoked
token. Every real call-placing/modifying site now resolves through it: the outbound-call trigger,
admin force-end, AMD machine-answer redirect, in-call hangup/transfer (stream.ts), the workflow
scheduler's retry dial, and the workflow engine's SMS action.

**Critical correctness issue found and fixed while implementing:** `requireTwilioSignature`
validated every webhook (`/incoming`, `/status-callback`, `/recording-status`,
`/amd-status-callback`) against one global `TWILIO_AUTH_TOKEN`. Twilio signs a webhook with the auth
token of whichever account actually placed/owns that call — for a sub-account or BYO org, that's a
different token than the platform default. Left unfixed, every one of those orgs' webhooks would
have been silently rejected as invalid signatures the moment this feature shipped. Fixed by resolving
the right token per request: `CallSid` -> `calls.orgId` (covers status/recording/AMD callbacks, and
the outbound leg of `/incoming` once its call row exists) -> falls back to dialed number (`To`) ->
`orgs.outboundNumber` (covers a genuinely fresh inbound call with no DB row yet) -> global token as
the final fallback (unchanged behavior for platform-only orgs). Added
`voice/middleware/twilio-signature.test.ts` covering all four resolution paths, since this had zero
test coverage before and is exactly the kind of bug that only surfaces in production against a real
sub-account.

**Security note:** the raw Twilio auth token is never returned by any API response — not
`GET /orgs/:orgId` (previously did leak it via `db.select().from(orgs)` spreading into a generic
admin JSON blob, fixed as part of this change), not `/orgs/overview`, not the new
`GET /orgs/:orgId/twilio` status endpoint (masked SID only, `usingGlobalDefault` flag, no token
field at all). Admin actions that touch it (`twilio.subaccount.created`, `twilio.byo.set`,
`twilio.reset`) log the action and non-secret metadata (SID, phone number) to the audit log, never
the token itself.

**Admin surface:** added a Telephony section to the existing org-detail expand panel
(`dashboard/orgs.tsx`) — status display (mode, masked SID, number), create-sub-account / buy-number
actions for platform mode, a BYO credentials form, and reset-to-platform-default. No merchant-facing
(`/app`) UI yet — this is an ops/admin action for now, not something a merchant self-serves; that's a
natural follow-up, not built here.

**Consequences:** No existing org affected — new columns nullable/defaulted, `getTwilioClientForOrg`
falls through to the exact same global client as before when nothing org-specific is configured.
Verified: api tsc + 134/134 tests (4 new), web tsc + tests + build, openvent-compliance tsc + 25/25
tests, root lint — all clean.

---

## ADR-043 — Passwordless sign-in switches from magic link to email OTP code; Weeber-branded auth emails

**Date:** 2026-07-10

**Context:** The magic-link flow is fragile in the split deploy because it depends on the Supabase
redirect-URL allowlist matching the frontend's live origin — and that origin has been churning
(weeber.ai bought but not yet wired to the current project, multiple `*.vercel.app` deployment
URLs). A stale allowlist or Site URL silently breaks every sign-in link. The auth emails were also
stock Supabase templates with no Weeber branding. (Same session also root-caused the "session may
have expired" error screen to a missing `VITE_API_BASE_URL` on the Vercel build — an env/redeploy
fix, no code change; noted here because it's why the magic-link flow was under scrutiny.)

**Decision:** Passwordless sign-in is a 6-digit email OTP, not a magic link — the code is verified
inline on the login page (`verifyOtp({ type: "email" })`), which has zero dependency on redirect
URLs, Site URL, or which domain the frontend is on this week. Supabase supports putting both
`{{ .ConfirmationURL }}` and `{{ .Token }}` in one template (both would work from the same email),
but the sign-in and signup-confirmation templates are deliberately code-ONLY so there is no
broken-link path at all. Password reset is the one flow that keeps its link (the
`/app/auth/reset-password` page works off the recovery token in the URL, per ADR-041), so the
redirect allowlist now only matters there. All three templates (`supabase/templates/*.html`) are
Weeber-branded: dark monochrome per ADR-039, tokens hand-converted to email-safe hex (bg `#0A0A0A`,
card `#171717`, text `#E5E5E5`, muted `#8A8A8A`, border `#262626`), table-based inline-styled HTML,
text wordmark only (no logo asset — final brand assets are still STOP-AND-ASK item #2). Wired into
`supabase/config.toml` (`[auth.email.template.*]`); the hosted project needs the same HTML applied
via `supabase config push` or pasted into Dashboard → Authentication → Emails — the committed files
are the source of truth either way.

**Consequences:** `/app/auth/callback` stays routed (already-sent emails, possible future OAuth)
but nothing links to it anymore. The login page's "Magic link" tab is now "Email code" with a
send-then-verify two-step; `signInWithOtp` still auto-creates users (unchanged default), and a
brand-new user entering that flow gets the confirmation template's code, which the same
`type: "email"` verify accepts. Sign-in emails can no longer break from domain changes;
password-reset emails still can — when the real domain goes live, update Site URL + the allowlist
for that one flow.

---

## ADR-044 — Fixed `.theme-weeber` light/dark color inversion bug

**Date:** 2026-07-11

**Context:** User reported the product theme (`/dashboard`, `/app`) looked wrong — expected black+grey
for dark mode and white for light/day mode, but the app didn't behave that way. Investigation found a
real bug, not a preference mismatch: base `.theme-weeber` (applied regardless of light/dark toggle)
held the near-black monochrome palette itself (`--weeber-paper: oklch(0.145 0 0)`), while
`.theme-weeber.dark` held an entirely unrelated leftover warm/purple palette from the original
ADR-032 round (chroma 0.014–0.019, a blue-violet `oklch(0.68 0.16 275)` accent) that ADR-039's
"recolor to monochrome" pass never actually touched. Net effect: the default/light state rendered
near-black, and toggling to "dark" made it warmer and purple-accented instead of darker and
monochrome — exactly backwards from "light = white, dark = black/grey."

**Decision:** Rewrote both blocks in `packages/web/src/web/styles.css`. Base `.theme-weeber` is now
the real light-monochrome variant (near-white background `oklch(0.99 0 0)`, near-black text,
light-grey borders, black-on-white inverted accent). `.theme-weeber.dark` now holds the correct
near-black monochrome palette that used to sit in the base block. The stale warm/purple block is
gone entirely, not just superseded. Semantic success/warning/error colors were re-tuned for each
background (light-mode soft variants are light tints, not the dark-mode dark tints) — same hues,
adjusted lightness only, still the one deliberate non-monochrome exception per ADR-039.

**Verified visually** (screenshot, `/app/login` with Supabase unconfigured so only the shell chrome
renders): default/light state is white background with black text; `weeber_theme=dark` in
localStorage renders near-black background with light-grey text, no purple/warm tint anywhere.

**Consequences:** No component code changed — every page reads through the same CSS variables
(`bg-background`, `text-foreground`, etc.), so this was a single-file fix. Any user who had
`weeber_theme=dark` set in localStorage before this fix will now correctly see monochrome dark
instead of the old warm/purple theme (a visual change, not a regression — the old dark state was the
bug).

---

## ADR-045 — Weeber marketing/waitlist page: faithful visual port from Vocalist, real brand assets

**Date:** 2026-07-11

**Context:** The landing page's waitlist section (built ADR-041) was a from-scratch minimal
reinterpretation into `.theme-weeber`'s dark-monochrome system — deliberately not a copy of
Vocalist's actual marketing site. User explicitly corrected this: wanted Vocalist's real design
replicated exactly (animations included, copy verbatim), not reinterpreted. Separately, `index.html`
and `public/` were still branded for "OpenVent" (the unrelated open-source self-hosted portfolio
project this template was originally bootstrapped from) — wrong title, meta tags, OG image,
JSON-LD, and a generic favicon/logo instead of Weeber's actual brand assets.

**Decision:** Full faithful port of Vocalist's `src/pages/Waitlist.tsx` (its entire pre-launch
homepage — hero, live agent demo widget with real recorded call audio, animated stats, verticals,
how-it-works, platform/integrations, upcoming verticals, security, "why we exist," founders quote,
FAQ) plus its nav, footer, and enterprise-inquiry dialog, using Vocalist's copy verbatim where it
still applies. Kept as a **separate token system** (`.marketing`, `--m-*` in styles.css) from
`.theme-weeber` (`--weeber-*`) — same separation Vocalist itself has between its marketing site and
product dashboard; the public site and the product surfaces are allowed to look different on
purpose.

Adapted for openvent's stack (not a byte-copy):
- `react-router-dom`'s `Link to=`/`useLocation` (object) → wouter's `Link href=`/`useLocation`
  (tuple), in `MarketingNav`/`MarketingFooter`.
- Supabase edge functions (`waitlist-join`, `waitlist-phone`, `enterprise-inquire`) → openvent's own
  backend: `POST /api/public/waitlist` + `/waitlist/phone` (already built, ADR-041's referral/
  position/count system — kept as-is, only the visual layer changed) and a new
  `POST /api/public/enterprise-inquiry`, routed through the existing `support_tickets` table with a
  fixed `"Enterprise inquiry"` subject tag rather than a dedicated table — a single lead-capture
  form doesn't need its own schema.
- Referral URL uses `window.location.origin` instead of a hardcoded domain.
- Real brand assets fetched from Vocalist's `public/` (`weeber_logo_transparent.png`,
  `weeber_favicon_transparent.png`, two real recorded demo-call MP3s) and the old OpenVent-OSS
  `favicon.ico`/`logo-mark.png`/`logo-lockup.png` removed. `index.html` fully rebranded — title, meta
  description/keywords, OG/Twitter tags, JSON-LD, favicon links — from "OpenVent — Self-Hosted Voice
  Agent Infrastructure" to Weeber's actual copy. New `WeeberLogo` component (ported as-is).
- Fixed three lint violations the ported markup introduced (`no-autofocus` on the enterprise dialog's
  step inputs, `media-has-caption` on the demo audio — same disable-comment pattern already used
  elsewhere for a synthesized-audio player with no caption track available, `no-redundant-roles` on
  nav/footer's explicit `role="banner"`/`role="contentinfo"`, which duplicate the elements' implicit
  ARIA roles).

**Known gap, not fixed here:** the OG image (`og-image.png`) is still the old OpenVent-OSS one —
Vocalist's own `public/images/og-image.png` reference was a broken/placeholder file when fetched, no
valid replacement available. A real 1200x630 Weeber-branded OG image is a follow-up, not blocking.

**Consequences:** Verified with a real build + screenshot (light mode: white hero, waveform bars,
demo widget rendering correctly with the actual COD-confirmation audio; confirms ADR-044's color fix
alongside it). api tsc + 144/144 tests, web tsc + tests + build, openvent-compliance tsc + 25/25
tests, root lint — all clean.

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

---

## ADR-047: Setup modal, not a setup page — vertical-driven dashboard as the default landing route (2026-07-12)

**Context:** The merchant `/app` route pointed straight at a dedicated full-page onboarding wizard
(`pages/app/onboarding.tsx`), permanently pinned in the nav as "Setup," with step completion derived
live from `shopify/status` + `agent-configs` on every load (no persisted step/dismiss state). This is
a Shopify-only shape: `VerticalDefinition` (`lib/verticals.ts`) only carried `glossary`/`nav`/`copy`,
no dashboard content, and only one vertical (`shopify`) was ever registered — the "every vertical gets
its own dashboard metrics/cards" requirement had no seam to hang off of.

Studied two references before deciding: (1) Vocalist (github.com/Aurora-091/Vocalist, read-only
clone), whose `Dashboard.tsx` mounts an `OnboardingModal` (Dialog/Drawer) that auto-opens only when
`onboarding_state.steps` is incomplete AND the org has zero agents, with a persistent checklist card
on the dashboard for any steps the modal doesn't cover; `vertical_configs` is a global DB table
(`config` jsonb: glossary, recommended integrations/templates, dashboard metrics/cards) so adding a
vertical is an insert, not a code branch. (2) Vapi/Retell/typical SaaS practice: checklist/progress
widget on the main dashboard, not a page that gates the rest of the product.

**Decision:**
- `/app` now renders `pages/app/home.tsx` (a lightweight dashboard: checklist card while setup is
  incomplete, vertical-driven metric tiles, quick links to Agents/Conversations/Analytics) instead of
  the onboarding page. `pages/app/onboarding.tsx` is deleted; `/app/onboarding` redirects to
  `/app?setup=1`, which force-opens the modal for old bookmarks/links.
- New `components/app/setup-modal.tsx` (Dialog) holds the exact same 3 steps (connect store → pick
  agents → review & activate) and mutations the old page had — only the shell changed. It auto-opens
  from `home.tsx` when steps are incomplete and not dismissed, same gate as Vocalist.
- New `onboarding_state` table (`org_id` PK, `steps` jsonb, `dismissed`, `completed_at`,
  `updated_at` — drizzle migration `0011_grey_scarlet_spider.sql`) plus `getOnboardingState` /
  `updateOnboardingState` (`voice/org-queries.ts`) and `GET`/`PATCH /api/app/onboarding`
  (`app/routes.ts`). Steps are a free-form jsonb bag (`ONBOARDING_STEP_KEYS`), not one column per
  step, so the step set can change without a migration. The modal PATCHes step flags as they change,
  so the dashboard checklist and "resume where I left off" stay accurate even if the modal is closed
  mid-way.
- `VerticalDefinition` (`lib/verticals.ts`) gained a `dashboard` shape (`metrics[]`, `emptyState`) —
  the Home page renders these instead of hardcoding Shopify-shaped tiles, so a Clinic/Insurance/Real
  Estate vertical added later gets its own dashboard content by filling in config, not by branching
  `home.tsx`. Nav also lost the separate "Setup" entry (folded into "Home").

**Explicitly not built:** no onboarding state-machine library — a jsonb steps column is enough at this
scale (proven in Vocalist production). No per-vertical dashboard component fork (separate `home.tsx`
per vertical) — config-driven tiles are enough for now. No change to the dedicated
Agents/Calls/Analytics/Billing/Integrations pages — only the entry point changed.

**Consequences:** Verified: `packages/api` tsc clean, `packages/web` tsc clean, drizzle migration
generated and reviewed (also picked up pre-existing unmigrated drift: `workflow_templates`/
`workflow_runs`/`org_workflow_configs` tables and `orgs.webhook_url`/`scheduled_calls.workflow_run_id`
columns that existed in `schema.ts` but had no prior migration file — bundled into 0011 rather than
split out, since it's one accurate diff against the last snapshot). Not yet run against a live
database (no `DATABASE_URL` in this environment) — run `db:migrate` before deploying. The two
vertical-dashboard metric tiles (`carts_recovered`, `revenue_recovered`) render as `—` placeholders
today since no backend aggregation computes them yet; wiring real values is follow-up work, not part
of this change.

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

## ADR-050: Merchant impersonation removed entirely (2026-07-12)

**Context:** Impersonation ("Log in as" from the Users/Orgs admin pages, `X-Weeber-Impersonation`
token auth path, `impersonation_sessions` audit table) was built per CLAUDE-BUILD-BRIEF.md §4 point 6
as a hard-audited admin capability. User decided to remove it completely rather than keep it around
as unused surface area — no replacement (e.g. a read-only admin view of an org) requested, at least
for now.

**Removed:**
- Backend: `app/impersonation.ts` + its test file (deleted), the `X-Weeber-Impersonation` branch in
  `requireMerchantSession` (middleware/supabase-auth.ts — now Supabase-session-only, no dual auth
  path), `POST /api/app/impersonation/stop`, `POST /api/voice/impersonation/start`,
  `POST /api/voice/impersonation/:id/stop`, `GET /api/voice/impersonation/audit`, and the
  `activeImpersonations` field on the admin org-detail response.
- Frontend: the "Log in as" action + audit trail UI on the Users page, the "Impersonate Workspace"
  button on the Orgs page, `ImpersonationBanner` + all impersonation branching in
  `merchant-shell.tsx` (now a single Supabase-session gate, no `impersonating` flag), and the
  impersonation-token helpers in `lib/merchant-session.ts`.
- Database: `impersonation_sessions` table dropped via migration (see changelog.md) — historical
  impersonation audit rows are gone, not archived. User explicitly chose this over keeping the table
  as inert clutter.
- `MerchantMe`'s `impersonated` field removed from the `/api/app/me` response contract.

**Not done:** no replacement read-only "view an org's data without acting as them" feature was built.
If admin support/debugging needs this later, it should be scoped as its own feature, not a
resurrection of impersonation's write-capable token auth.

---

## ADR-051: Agent Preview drawer — live voice test call is a parallel sandbox handler, not a 4th telephony provider (2026-07-12)

**Context:** `AGENT-CONSOLE-UI-PLAN.md` scoped a two-phase Preview drawer (top-right on both
`/app/agents` and `/dashboard/agents`): Phase 1 a backend-wired Text tab + TTS-reactive orb testing
the *current unsaved form state*; Phase 2 a real full-duplex in-browser voice test call. Both phases
shipped this session (commits `03b3d40`, `8001d9d`) but were never written up here or in
`changelog.md` until now — backfilling so a fresh session has the full picture.

**Phase 1 decision:** rather than duplicating agent-config resolution, `buildPreviewAgentConfig`
builds a full config from an in-memory `AgentFrame` override (validated by the existing
`AgentFrameSchema`) with the same fallback-to-template-default behavior a saved config would have.
Both test-chat routes accept this override optionally — omit it and you get the existing
saved-row behavior (`resolveAgentConfig`) unchanged. No new endpoints; existing ones extended.

**Phase 2 decision (the one worth defending):** the live voice test call is **not** a 4th provider
inside `createVoiceStreamHandlers`/`stream.ts` alongside twilio/plivo/exotel. That engine's job is
running *real* calls — it persists DB call rows, fires workflows/webhooks, and enforces
DNC/compliance/caller-memory. None of that belongs in a config-testing sandbox, and bolting a
"don't persist/don't enforce DNC" escape hatch onto the real-call engine is worse than a small
amount of duplication. Instead `voice/test-call-stream.ts` is a standalone handler that reuses only
the shared pipeline primitives (`connectStt`, `connectTts`, `runVoiceAgentTurn`,
`runVoiceAgentGreeting`) — genuinely the real STT→LLM→TTS pipeline, just without a phone number,
DB row, or compliance gate, and hard-capped at 5 minutes.

**Auth decision:** browser `WebSocket` clients can't set custom headers, so neither a raw session
cookie nor an API key can ride safely in the WS URL. Solved with a two-step token handshake: an HTTP
POST (normal session/admin-key auth, rate-limited) issues a short-lived (2 min), single-use,
in-memory token; the WS upgrade at `/api/voice/test-call?token=...` consumes it once. Mirrors the
`previewRateLimited`/`testChatRateLimited` "meter at the HTTP entry point, not per WS message"
pattern already established for the other test surfaces.

**Wire format decision:** 8kHz mu-law, matching what `connectStt`/`connectTts` already expect from
real Twilio/Plivo/Exotel streams — this made the browser the one side that needed new codec work
(`lib/audio-codec.ts`, browser-safe port of the API's mulaw/pcm16 math), while the backend pipeline
needed zero changes.

**Known tradeoff accepted:** `ScriptProcessorNode` (deprecated but functional everywhere evergreen)
is used for mic capture instead of `AudioWorklet` — smaller/faster to ship correctly this session;
flagged as a reasonable future migration, not urgent.

**Not done / explicitly out of scope (per the plan doc):** Phase 3 (Mock-tools toggle, inline vs.
floating-widget toggle, Vars/merge-tag preview) is deferred until the workflow-canvas variable
system and/or a public embeddable widget surface actually exist — building that UI ahead of the data
it would inject would be building for nothing.

---

## ADR-052: "Merchant" renamed to "User" as the tenant-facing actor term (2026-07-13)

**Context:** Weeber is multi-vertical (Shopify today, Clinic next, Insurance/Hospital planned).
The tenant-facing app surface's internal naming (`MerchantShell`, `requireMerchantSession`,
`merchant-session.ts`, `MERCHANT-APP-PAGE-MAP.md`, etc.) hardcoded "merchant" — accurate for a
Shopify store owner, meaningless for a clinic or an insurance company. User explicitly flagged
this: "shopify merchants are one of our users... they are user like our upcoming clients like
insurance and hospitals." Rather than treat this as a minor copy issue, it's a real signal that
the platform's own vocabulary was still Shopify-shaped even though the data model (`orgs`,
`vertical` column, `VerticalDefinition` config) was already correctly vertical-neutral.

**Term chosen: "User".** Two other candidates were ruled out on collision grounds, not
preference: "Customer" was already taken by `verticals.ts`'s `glossary.customer` (the org's own
end-customers/patients being called — the opposite end of the relationship), and inventing a
third term ("Client") when the admin dashboard's Users page (`pages/dashboard/users.tsx`) already
calls exactly these people "Users" would have created inconsistency instead of fixing it. "User"
was the zero-new-vocabulary option.

**Scope: naming only, not a data-model or behavior change.** The DB schema needed no migration —
table/column names never said "merchant" anywhere. This was purely code identifiers (~55 files),
file names, and living reference docs. Historical records (`changelog.md`, `DECISIONS.md`,
`AGENT-CONSOLE-UI-PLAN.md`, `project_analysis.md`, `audit/*.md`) were deliberately left
untouched — rewriting a past changelog entry or ADR to use today's vocabulary would misrepresent
what was actually true at the time it was written. Genuine Shopify-vendor terminology was also
left alone: the three Shopify-vertical agent prompt docs' `{{merchant_name}}` template variable
(Shopify's own word for a store owner, appropriate in a Shopify-specific system prompt) and two
narrative copy references to real Shopify merchants in `landing.tsx` and `email-templates.ts`.

**Infra decision: backward-compat shim over a coordinated cutover.** The live `weeber-merchant`
Vercel project was created with `VITE_APP_SURFACE=merchant` during the subdomain split (ADR-051's
era). Rather than requiring the code push and the Vercel env var change to land in the same
instant (a real outage-window risk on a live production surface), `app.tsx` and
`lib/route-base.ts` both normalize the legacy `"merchant"` value to `"user"` at the point the env
var is read. Verified both values produce byte-identical-size builds. The Vercel project rename
and env var flip remain a manual dashboard step (no rename-project or update-env-var action
exists in the available Vercel API tooling) — the shim means there's no urgency or ordering
requirement on when that happens. Remove the shim once confirmed flipped.

---

## ADR-053 — Correction to ADR-043: password reset also went OTP-only; `reset-password.tsx` kept as speculative scaffolding (2026-07-13)

**Context:** Audit #03 found that ADR-043's stated decision — *"Password reset is the one flow that keeps
its link... the redirect allowlist now only matters there"* — is no longer true. At some point after
ADR-043 was written (2026-07-10), the hosted Supabase project's recovery email template was replaced with
a fully code-based one (`supabase/templates/recovery.html` now renders only `{{ .Token }}`, no
`{{ .ConfirmationURL }}` at all), and `login.tsx`'s forgot-password flow was built as a complete 3-step
inline OTP verification (`resetPasswordForEmail` → `verifyOtp({ type: "recovery" })` →
`updateUser({ password })`) — no link involved anywhere. That change shipped as part of the
2026-07-13 hosted-Supabase-config-sync work (`cbf976d`, changelog "Hosted Supabase auth config synced"),
referenced only as "ADR-043 extended" in the template file's own comment, with no dedicated decision
record explaining the change. This ADR is that missing record, and formally supersedes ADR-043's now-false
claim.

**Decision:** All three Supabase auth email flows (sign-in, signup confirmation, password reset) are
code-only OTP as of 2026-07-13. None of them depend on the redirect-URL allowlist, Site URL, or which
domain the frontend happens to be on. The allowlist (`supabase/config.toml`'s
`additional_redirect_urls`) is kept clean regardless (audit hygiene + covers `/auth/callback` and any
future OAuth flow), but no *live* flow reads it today.

**On `packages/web/src/web/pages/app/reset-password.tsx`:** this page (and its route,
`appPath("/auth/reset-password")` in `app.tsx`) is unreachable through the normal product flow — nothing
sends a link that lands on it anymore. Explicitly decided to **keep it** rather than delete it, as
speculative scaffolding for a future OAuth provider (Google/Microsoft sign-in), which — if ever added —
would plausibly reuse this page's `onAuthStateChange`/`PASSWORD_RECOVERY`-adjacent session-detection
pattern for its own callback landing. This is a deliberate "keep unused code because it's cheap and might
be reused" call, not an oversight — flag it for actual deletion only if a future audit finds it's still
unused once OAuth is either built (and reuses it) or is decisively taken off the roadmap.

**Consequence:** no code changed as part of this ADR — it's a documentation correction plus an explicit
decision to keep already-existing dead code. Future readers of ADR-043 should treat its "keeps its link"
claim as historical (true as of 2026-07-10, false as of 2026-07-13) rather than current.

---

## ADR-054 — Dialogs/sheets/dropdowns/tooltips/selects render inside the themed shell via a portal-container context (2026-07-13)

**Context:** Audit #04 (`audit/2026-07-13-audit-04-uiux.md`) reconfirmed a bug first documented in
`docs/UI-UX-AUDIT-CONTEXT.md` §1: every Radix Portal-based overlay (Dialog, Sheet, DropdownMenu, Tooltip)
defaulted to portaling into `document.body`, outside the shell `<div>` carrying the
`.theme-weeber`/`.dark` classes (`app-shell.tsx`). Overlays silently fell back to `:root`'s default
(old ember/light) theme regardless of the user's actual theme. The audit also found a second, stacked bug:
the mobile nav Sheet's custom slide animation targeted `[data-radix-dialog-content]` — an attribute Radix
never actually emits — so it was dead on arrival even before the portal issue.

**Decision:** rather than promoting `.theme-weeber`/`.dark` to `<body>` (the audit doc's alternative
option — simpler in principle, but risks touching the marketing/landing pages, which deliberately never
read those classes today), added a small `PortalContainerContext`
(`packages/web/src/web/lib/portal-container.ts`) that `AppShell` provides via a ref to its own themed
root div. `Dialog`, `Sheet`, `DropdownMenu`, `Tooltip`, and `Select` (shadcn ui/ primitives) all read it
and pass the DOM node as their Radix `Portal`'s `container`. An explicit `container` prop, if ever passed
manually by a caller, still wins over the context default. Pages rendered outside any `AppShell`
(marketing/landing) get `null` from the hook and keep Radix's default `document.body` behavior unchanged
— `EnterpriseDialog.tsx`'s existing hardcoded `dark:` workaround for exactly this class of bug is
untouched, by design, since it never sits inside a themed shell to begin with.

Also fixed the dead CSS alongside this: `[data-radix-dialog-content]` → `[data-slot="sheet-content"]`
(the sheet's real DOM attribute), plus added `data-side={side}` to `SheetContent` so the
`[data-side="left"]` qualifier has something to match too — both the portal-escape bug and the wrong-
attribute-name bug are now genuinely fixed, not just one of the two.

`portal-container.ts` is deliberately a standalone module, not exported from `app-shell.tsx` — the ui/
primitives it's imported into (`sheet.tsx`, `tooltip.tsx`) are themselves imported by `app-shell.tsx`,
so putting the context there would create a circular import.

**Consequence:** every overlay in the authenticated product (`/app/*`, `/dashboard/*`) now correctly
inherits whatever theme the shell is in, including any future theme changes — no more per-component
`dark:` hardcoding needed as a workaround (don't reintroduce that pattern; fix at the shell if a new
one-off appears). No visual change for anyone already on the correct theme in a non-portaled context;
this only changes where portaled overlays *render into*, not their content or styling.

---

## ADR-055 — Agent console: full-window layout via a new `AppShell` `fullBleed` opt-out (2026-07-13)

**Context:** long-standing ask (predating this session, referenced in `docs/UI-UX-AUDIT-CONTEXT.md` §2):
the agent config page should behave like a full-window console — a slim top bar with just an
agent-switcher pill/dropdown, not the standard article-width `PageHeader` layout every other page uses,
with the config form filling the remaining viewport.

**Decision:** rather than a one-off layout special-cased into `/app/agents` and `/dashboard/agents`
directly, added a `fullBleed?: boolean` prop to `AppShell` itself: when set, `<main>` skips the standard
`max-width`/padding container (`--shell-page-max-w` etc.) in favor of the full remaining viewport height
(`h-[calc(100vh-3rem)] md:h-screen`, accounting for the mobile topbar). Threaded through `UserShell` and
`DashboardShell` (both already instantiated fresh per-route in `app.tsx`, e.g.
`<UserShell><UserAgentsPage /></UserShell>`), so it's opt-in per route rather than a global shell change.
Only `/app/agents` and `/dashboard/agents` use it today.

`/app/agents` (merchant): the agent-switcher pill (already existed as a conditionally-shown `<select>`)
is now always visible in a slim top bar, even with a single agent, so the chrome stays consistent as
more agents get added — replaces the previous `PageHeader` entirely on this page. `/dashboard/agents`
(admin): same top-bar treatment applied to the existing org picker (now a pill, consistent styling with
the merchant page), keeping the accordion list of agents below it rather than rebuilding that mechanic —
lower risk than a full rewrite, same visual language.

Also added `collapsible` to `DashboardShell` (previously only `UserShell` had sidebar icon-collapse) for
parity between the two shells, and added missing `isError` states to both agent-configs fetches (a
fetch failure was previously indistinguishable from "no agents configured yet").

**Consequence:** `fullBleed` is available to any future page needing this treatment (the Workflow
Canvas editor pages are a natural next candidate, not done as part of this ADR). The agent-page
full-window redesign requested layout decisions the original audit doc flagged as open (collapse-to-
icons vs. full-hide; pill placement; admin org-picker parity) — resolved here as: icon-collapse (existing
mechanism, not full-hide), pill replaces the page header entirely, and the admin org-picker gets the same
pill treatment rather than being dropped.

---

## ADR-056 — Correction: the "38 pre-existing test failures" baseline cited across many prior sessions was a false signal, not real bugs (2026-07-16)

**Context:** asked to investigate/fix the "38 pre-existing failures" that `changelog.md` and several
docs (`docs/hindi-hinglish-voice-support.md`, `docs/workflow-canvas-v2-and-multivoice-research.md`)
had repeatedly cited as an accepted, unchanging baseline across many separate work sessions (e.g. "296
pass / 38 fail", "305 pass / 38 fail (same pre-existing baseline, no new failures)").

**Finding:** there were never 38 real failing tests. `packages/api/package.json`'s actual `test` script
is `bun test --isolate src/` — the `--isolate` flag runs each test file in its own module registry.
Every prior session's verification step ran bare `bun test` (no `--isolate`) instead of `bun run test`,
which shares one module registry across all 58 test files in a single process. That let module-level
mocks (`global.fetch` overrides in `salesforce.test.ts`/`hubspot.test.ts`/`google-calendar.test.ts`/
`gohighlevel.test.ts`/`shopify/routes.test.ts`, plus other module-scope state in
`resilient-fetch.ts`'s circuit breaker, LLM-provider resolution, and Twilio-signature org resolution)
leak across files depending on run order — every one of those individual test files passes cleanly
in isolation. Confirmed directly: `bun run test` → **353 pass / 0 fail** (not 305/38 or any of the
smaller historical counts); bare `bun test` on the same unchanged code → 38 failures, all in files that
mutate `global.fetch` or module-level singletons without per-file isolation.

**Decision:** the real, current baseline is **353 pass / 0 fail**, via `bun run test` (not bare
`bun test`). No source or test code changed — this was purely a verification-command mistake repeated
across sessions, not a real regression or flaky-test problem. Every historical "38 fail (same
baseline)" note in `changelog.md`/the two docs above should be read as "the verification command used
was wrong," not "38 tests were actually broken the whole time."

**Consequence:** always verify with `bun run test` (reads the package script, includes `--isolate`)
going forward, never bare `bun test` in this repo. Nothing else to fix or ship from this — flagging so
future sessions don't keep re-citing a phantom 38-failure baseline as if it were real or acceptable.

---

## ADR-057 — Pricing locked (internal only, not deployed): geo-differentiated tiers, split by voice cost, minutes not calls (2026-07-18)

**Context:** following up on `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md`'s sourced
COGS findings (provider choice alone swings real per-minute cost 2.5-9x — Sarvam-optimized
~₹1-1.5/min vs. Cartesia/Deepgram ~₹4/min vs. ElevenLabs ~₹11-13/min), plus fresh competitor
pricing research (Bolna, HuskyVoice, Dvaarik, Vapi, Retell, Bland, ElevenLabs — real effective
rates, not headline marketing numbers) and a review of Dvaarik AI specifically as a sharper India
competitive reference than Bolna (solo-founder, ₹2/min, done-for-you onboarding, honest `/compare`
pages — see chat history for the full breakdown).

**Decision:** final locked pricing — full detail, unit economics, and explicit caveats in
`docs/product-strategy/pricing-lock-2026-07-18.md`. Summary:
- Unit is **minutes**, not "calls" (call length varies too much across verticals for calls to be a
  meaningful sold unit).
- **Split-rate by voice tier**: plans price against a standard stack (Sarvam or Deepgram/Cartesia)
  by default; ElevenLabs/premium voice is an explicit, separate surcharge, never silently absorbed —
  this directly closes the margin risk ADR/finding from the 2026-07-17 COGS audit (the agent config
  UI recommends ElevenLabs for Hindi/Hinglish with no cost guardrail; the UI-disclosure fix shipped
  2026-07-18, see `changelog.md`, but pricing itself needed to account for it too).
- **India and Global are geo-differentiated, separate pricing pages** (not a currency toggle) —
  COGS is dollar-flat across geography, but willingness-to-pay differs 3-5x, and compliance framing
  genuinely differs (DPDP/TRAI/DLT vs. TCPA/state-licensing).
- **India Starter locked at ₹2,499/mo**, 357 minutes included, ₹8/min overage. Margin range 43-83%
  depending on which standard-stack option (Sarvam vs. Cartesia/Deepgram) the agent actually runs.
- **Global Starter locked at $79/mo**, 790 minutes included, $0.10/min all-inclusive overage
  (deliberately undercuts Retell/Vapi's *real* effective cost, not just their headline number).
- Growth/Scale tiers for both markets, and full unit-economics math, are in the linked doc.
- Telephony is excluded from the per-minute rate wherever the merchant BYOs their own number
  (the India-default assumption, mainly Exotel) — folded into COGS only where Weeber provisions
  Twilio directly (mainly Global), since Twilio's own rate is cheap enough to absorb rather than
  meter separately.

**Consequence:** **this is a decided-but-not-deployed pricing structure** — explicitly not yet
reflected on the live marketing site, not wired into checkout/billing, and no plan-tier enforcement
exists in the product (an org can still pick ElevenLabs regardless of nominal tier; only the
cost-disclosure UI fix from 2026-07-18 exists today, not an enforcement gate). Use these locked
numbers for grant applications, investor materials, and internal financial models going forward —
don't re-derive pricing from scratch each time. Any future session updating the public pricing page
or wiring real billing off these numbers should treat that as a separate, explicit go-ahead, not
implied by this ADR.

---

*Next entry number: ADR-058. Add new entries above this line, keeping numbering sequential and dates
accurate to when the decision was actually made.*
