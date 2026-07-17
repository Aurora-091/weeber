## Status update (2026-07-12, later same day): real call transport built — and a correction

Live protocol docs were pulled directly from Plivo and Exotel (not assumed) while building this, and
one earlier claim in this doc turned out to be **wrong and is now corrected**: Exotel is NOT SIP-trunk-
only anymore. Exotel's AgentStream product now ships a real bidirectional WebSocket (the "VoiceBot
Applet") structurally close to Twilio's Media Streams — no LiveKit SIP bridge needed after all. The
"Exotel = SIP+LiveKit, Plivo = WebSocket, prototype both" framing further down this doc is superseded by
what's below; kept in place further down as historical record of the reasoning at the time, not as
current guidance.

**What's now real, not just credentials:**
- `voice/telephony-transport.ts` — per-provider wire-format adapter. Twilio and Plivo both speak mu-law
  8kHz already (Plivo's Audio Streaming protocol is close to a re-skin of Twilio's: `streamId`/`callId`
  instead of `streamSid`/`callSid`, `playAudio`/`clearAudio` instead of `media`/`clear` on the way out,
  otherwise the same shape). Exotel sends/expects raw linear16 PCM instead of mu-law — transcoded at the
  boundary only (`voice/audio-codec.ts` gained `pcm16ToMulaw`, alongside the existing `mulawToPcm16`) so
  `stream.ts`'s actual STT/agent/TTS pipeline never has to know which provider a call came from.
- `stream.ts` — `createVoiceStreamHandlers(provider)` now takes the provider explicitly and routes all
  wire I/O through the transport adapter instead of hardcoded Twilio JSON shapes. STT/TTS/agent logic
  itself is unchanged.
- `ws-route.ts` — three WS paths (`/api/voice/stream`, `/stream/plivo`, `/stream/exotel`), one per
  provider, so the right adapter is selected up front rather than sniffed from the first message.
- `voice/plivo-client.ts` / `voice/exotel-client.ts` — outbound call placement. Plivo: Call Create API +
  answer_url returning Plivo Stream XML (same call-then-webhook-returns-XML shape as Twilio — reuses one
  `/api/voice/incoming/plivo` route for both inbound and outbound, mirroring how `/incoming` already
  doubles as both for Twilio). Exotel: a single direct `/calls/connect` API call with `streamurl` — no
  separate webhook/XML round-trip, a genuinely different shape from Twilio/Plivo's.
- `voice/middleware/plivo-signature.ts` — validates `X-Plivo-Signature-V3`, algorithm taken directly from
  Plivo's own docs. Org resolution is via an `?orgId=` query param on the answer_url itself (Plivo's
  webhook is often the first request for a fresh call, with no DB row yet to look an org up from) —
  users wiring a Plivo number for pure inbound use need the same `?orgId=` on their Plivo
  Application's configured Answer URL.
- `calls.provider` column added — records which provider actually carried a call. `stream.ts`'s "start"
  handler also gained a lazy-insert fallback (using from/to off the start event itself) for Exotel, since
  unlike Twilio/Plivo it has no separate inbound webhook step that pre-creates the `calls` row before the
  WS opens.

**What's explicitly still not done / unverified — no live prototype call has been made for either
provider, this sandbox has no way to place one (no real Plivo/Exotel account, no public WS URL, no phone
to receive a call on):**
- Whether Plivo's immediate Call Create response (`request_uuid`) reliably equals the real `CallUUID` the
  WS `start` event later carries is unconfirmed — `plivo-client.ts` and the `/incoming/plivo` route are
  written so this isn't load-bearing either way (the answer webhook, not the create response, is treated
  as the authoritative point session/org context gets bound to the real CallUUID).
- Whether Exotel's `/calls/connect` response `call.sid` matches the `call_sid` in the later WS `start`
  event is unconfirmed for the same reason — `stream.ts`'s lazy-insert fallback exists specifically so a
  mismatch here doesn't leave a call with no DB row, just without this request's org/persona context.
- Mid-call hang-up (`performHangUp`) and transfer-to-human (`performTransfer`) — **Plivo now real,
  2026-07-17.** `plivo-client.ts`'s `hangupPlivoCall` (`DELETE /Call/{call_uuid}/`) and
  `transferPlivoCall` (`POST /Call/{call_uuid}/` with `legs=aleg` + a new `aleg_url`, served by
  this API's own `GET /transfer-xml/plivo` route) are both wired into `stream.ts`. Untested
  against a real Plivo account/live call for the same reason as everything else in this section —
  no real account/public WS URL in this sandbox — but the request shapes match Plivo's own
  documented API directly (`plivo.com/docs/voice/api/calls`), not a guess. **Exotel still
  no-op-with-a-warning** (falls back to hang-up on a transfer request) — its "Call Transfer"
  feature is dashboard/App-Bazaar-driven in Exotel's public docs, with no confirmed REST endpoint
  for hanging up or transferring an already-connected call the way Twilio/Plivo have; implementing
  against an unconfirmed endpoint would be guessing, not building, so this stays flagged rather
  than shipped.
- Unit tests cover the wire-format parsing/building and the mu-law<->PCM16 codec round-trip
  (`voice/telephony-transport.test.ts`) — that's confidence in the *protocol translation logic*, not a
  substitute for one real end-to-end call through each provider.

---

## Status update (2026-07-12): Plivo + Exotel BYO wired up

The "generalize the BYO pattern" section below is now implemented for credential storage/validation —
not for live call routing. Concretely:

- `orgs.telephonyProvider` (`twilio` | `plivo` | `exotel`) plus per-provider credential columns
  (`plivoAuthId`/`plivoAuthToken`, `exotelSid`/`exotelApiKey`/`exotelApiToken`/`exotelSubdomain`) exist
  in schema. `voice/plivo-provisioning.ts` and `voice/exotel-provisioning.ts` mirror
  `voice/twilio-provisioning.ts`'s BYO validate-before-store pattern (Plivo: `GET /v1/Account/{authId}/`;
  Exotel: `GET /v1/Accounts/{sid}/` against the account's own subdomain). `GET /api/app/telephony/status`
  returns all three providers' status plus which one is currently active; `POST
  /api/app/telephony/plivo/byo` and `/exotel/byo` connect them; `/telephony/reset` clears all three back
  to the Twilio platform default. User Integrations page has real Connect dialogs for both (no more
  "Coming soon" tiles).
- **This is credential wiring only, not the transport/media integration.** Plivo's WebSocket media
  streaming and Exotel's SIP+LiveKit bridge (both described below) are still unbuilt — a user who
  connects Exotel today gets their account recorded and their number set as `outboundNumber`, but calls
  do not actually route through Exotel's media path yet (`voice/stream.ts` is still Twilio/Plivo-shaped
  WebSocket only, and even Plivo's WebSocket adapter itself hasn't been built — only its credential
  validation has). The UI says this explicitly for Exotel. Neither vendor has had the "one real
  prototype call" this doc calls for below — that's still the next real step, not this credential work.
- No platform-owned Plivo/Exotel sub-account or number-purchase path exists (unlike Twilio's
  `createSubaccountForOrg`/`buyNumberForOrg`) — both are BYO-only, consistent with "DLT PE registration
  is a business-verification process, not an API call" further down this doc. A user with nothing
  existing still gets Weeber's shared Twilio platform default until a platform Plivo path is prototyped.

---

# India Telephony: Numbers, Regulation, and Provisioning

Reference doc for the actual mechanics of getting Weeber's agents onto real Indian phone numbers,
compliantly. This is deliberately separate from `packages/openvent-compliance` (which enforces DNC/calling-window
at the *code* level) — this doc covers the *telecom/regulatory* layer underneath that, which today assumes a
US/NANP-style model and needs a real India-specific pass (flagged since ADR-034).

## Why not Twilio for India

Twilio doesn't block India, but it routes Indian calls through international interconnect rather than
being a licensed Indian telecom operator — combined with TRAI's DLT/number-series requirements (below),
this means real compliance overhead and unreliable answer rates on outbound to Indian mobiles at any
volume. This isn't a Twilio-specific flaw so much as "foreign CPaaS + Indian telecom regulation" being a
structurally awkward combination.

## Exotel — the recommended Indian-native alternative

- **Purpose-built for AI voice agents**, not just call centers: **AgentStream**, their real-time voice
  streaming API, claims sub-20ms media latency and has a published reference architecture specifically for
  LiveKit + AI agent pipelines (Deepgram/ElevenLabs/LLM), targeting sub-800ms end-to-end conversational
  latency.
- **Licensed Indian telecom entity** — PSTN interconnect across 22 telecom circles, native DLT/TRAI
  compliance tooling, not a foreign company bolting on compliance features.
- **Ozonetel** is a credible second option — also India-native, has a direct listed ElevenLabs
  Conversational AI integration.

**Real integration catch, not a footnote:** Exotel's AI-agent path is **SIP-trunk based, bridged into
LiveKit** (or a similar WebRTC layer) — not a drop-in replacement for Twilio's raw Media Streams WebSocket
protocol (`start`/`media`/`stop` JSON, base64 mu-law) that `packages/api/src/voice/stream.ts` is built
against today. Migrating to Exotel means either:
1. Adding SIP-handling directly to this codebase, or
2. Fronting the India telephony path with a self-hosted LiveKit SIP bridge, with Vent's existing
   compliance/orchestration/agent code sitting behind it as the actual conversation brain.

Option 2 is the more realistic path — it reuses everything already built (compliance gates, workflow
engine, the 3 Shopify agents) and only swaps the transport layer for India specifically. This is exactly
the "LiveKit as a future transport-layer swap" scenario flagged as a maybe in the original LiveKit-vs-Vent
comparison — except the trigger turned out to be India telephony access, not concurrency scaling.
**Prototype this end-to-end (one real test call through Exotel → LiveKit SIP bridge → the existing agent
code) before treating it as a simple swap** — it hasn't been built or tested yet.

## Plivo — evaluated alongside Exotel, and the integration story is meaningfully different

Researched directly (Plivo's own docs, a dedicated 2026 India-telephony-vendor comparison piece, and
cross-referenced against multiple independent sources), not assumed, per the earlier flag that Exotel
shouldn't be the only vendor considered before committing.

**The one finding that changes the shape of this decision:** Plivo's real-time media streaming for AI
voice agents is **WebSocket-based** ("WebSocket Stream" — real-time audio streaming via WebSocket for live
transcription/AI processing), the same general architecture family as Twilio's Media Streams that
`packages/api/src/voice/stream.ts` is already built against — **not** the SIP-trunk-based approach Exotel
requires. This means a Plivo integration is plausibly a much smaller lift than the Exotel path: closer to
"adapt the existing WebSocket message handling to Plivo's JSON shape" than "bridge SIP through LiveKit and
sit the existing agent code behind that." This should be confirmed with one real prototype call the same
way Exotel's path needs one — not assumed correct without testing — but it's the more promising integration
shape on paper, and directly relevant to the transport-abstraction work already planned (see
`voice-quality-and-india-status-2026-07-12.md`): if Plivo's WebSocket shape is close enough, it may be the
*easier* second implementation of that abstraction, with Exotel/SIP as the third (or vice versa).

**Compliance/regulatory position:** Plivo is a legitimate DLT-registered path — they've partnered
exclusively with Tata Teleservices for 140-series (promotional) and 160-series (transactional/service)
number provisioning (per their own docs), consistent with the Tata DLT platform already named as an option
above. DLT support exists but is more self-serve than Exotel's — you drive more of the registration process
yourself rather than Exotel's more hands-on compliance tooling.

**Where the two actually differ, per a dedicated 2026 comparison (Plivo vs Exotel vs Ozonetel vs Knowlarity
vs Twilio for India voice AI):**

| Dimension | Plivo | Exotel |
|---|---|---|
| Best fit | Developer-led teams comfortable building against APIs | Teams wanting DLT/compliance handled with more hand-holding |
| DID provisioning speed | 24-48 hours | 2-5 business days |
| Per-minute pricing | Generally cheaper | ~10-25% more expensive than Plivo, justified by compliance/integration wrap |
| Media streaming maturity | Mature (WebSocket), listed among the most mature alongside Twilio | Mature, AgentStream claims sub-20ms media latency (best-in-class claim) |
| DLT/compliance hand-holding | Competent but more self-driven | Among the strongest — proactively flags violations, near-real-time scrub-list maintenance |
| CLI/number masking | Handled via API | Strong native support (relevant for marketplace/two-party-connect patterns, not Weeber's current shape) |

**Read for Weeber specifically:** Weeber is an engineering-led team building against APIs already (not a
non-technical buyer needing hand-holding), which is exactly the profile the comparison says fits Plivo
best. Combined with the WebSocket-vs-SIP integration-effort difference above, **Plivo is worth prototyping
first, not Exotel** — reversing the earlier default recommendation, pending the one-real-call prototype
that should happen for whichever vendor gets tried first. Exotel remains the stronger fallback if Plivo's
DLT self-service process proves too much overhead to drive alone, or if the WebSocket integration turns out
to have gaps the SIP+LiveKit path wouldn't.

**Ruled out for now, from the same comparison:** Ozonetel (CCaaS-first, built for contact centers layering
AI onto existing human agent operations — overkill for a pure voice AI SaaS product like Weeber), Knowlarity
(slowed product velocity post-Gupshup-acquisition, not recommended for a greenfield 2026 deployment), direct
Airtel/Jio/Tata SIP (only economical past 15-20 lakh minutes/month — far beyond Weeber's current or
near-term scale).

## Don't pick one India telephony vendor — generalize the BYO pattern that already exists

Real objection worth designing around from day one, not retrofitting later: **some users Weeber
targets already run their own IVR/telephony on Exotel (or another vendor)** and won't switch providers just
to use Weeber. Picking Plivo as "the" India vendor and forcing every user onto it is the wrong shape of
solution — it should be Weeber's own *default* for users with nothing existing, not the only option.

This is not a new problem — it's the exact shape of problem `getTwilioClientForOrg()`
(`voice/twilio-client.ts`) already solves for Twilio: every org either uses Weeber's platform Twilio
account, or brings its own sub-account/credentials (`orgs.twilioAccountSid`/`twilioAuthToken`), resolved
per-call, with the platform account as fallback. **The India telephony work should generalize this same
pattern to any provider, not add Plivo as a one-off:**

- `orgs` gains a `telephonyProvider` field (`twilio` | `plivo` | `exotel`, extensible) alongside
  provider-specific credential fields (mirroring today's Twilio-specific ones).
- The transport-abstraction layer already planned (see `voice-quality-and-india-status-2026-07-12.md`)
  resolves the right adapter per-org at call time, the same way `getTwilioClientForOrg` resolves the right
  Twilio client today — falling back to Weeber's own default (Plivo, pending its prototype) only when the
  org hasn't configured its own.
- **Practical effect:** a user already on Exotel plugs in their existing Exotel credentials and keeps
  using their own setup unchanged; a user with nothing existing gets Weeber's own Plivo-backed number
  provisioned for them. Both are first-class, not "the real one and the fallback."

This changes the shape of the upcoming transport-abstraction work: build the per-org resolver from the
start, with Plivo and Exotel as the first two real adapters (both genuinely needed, not one primary + one
speculative), rather than treating Exotel as something to maybe revisit after Plivo ships.

## The number-series reality (this is the part that changes the "80 number" question)

TRAI's current rules (TCCCPR, enforced via the DLT platform) are explicit and apply to **both** promotional
and transactional/service calls — this is broader than it might look at first glance:

- **140-series** — mandatory for all **promotional/marketing** voice calls. Personal/regular 10-digit
  mobile or landline numbers **cannot** be used for this anymore.
- **160-series (also referred to as "1600-series")** — mandatory for **transactional and service** voice
  calls. This is the one that actually matters for COD Confirmation and Feedback.
- The regulation text is explicit: *"Senders shall not use any other 10-digit fixed line/mobile number for
  making promotional/Service/transactional voice calls to their customers."* Note "Service/transactional"
  is in that same sentence — this was tightened specifically because 10-digit numbers were being widely
  misused for exactly this, not just for marketing.

**What this means for the 3 agents, concretely:**

| Agent | Call type under TRAI | Required series |
|---|---|---|
| Cart Recovery | Promotional (discount offer to close a sale) | **140-series** |
| COD Confirmation | Transactional/service (order verification) | **160/1600-series** |
| Feedback | Service (post-delivery check-in) | **160/1600-series** |

**This means Weeber likely needs two different registered number types, not one** — Cart Recovery can't
share a number with COD Confirmation/Feedback under current rules, since they're regulatorily different
call categories even though they're the same product.

**On the test call that showed a normal 10-digit ("80...") number:** that doesn't mean it's compliant or
safe to build around — it more likely means the platform tested (Bolna, in this case) is still operating on
a transitional/grandfathered number, or enforcement hasn't caught up with a specific case yet. TRAI
regulation-on-paper and TRAI enforcement-in-practice run on different timelines in India — a normal number
working today is not evidence it'll keep working, or that it wouldn't trigger a DND/UCC complaint against
Weeber specifically once real user volume starts. Building the compliance model around "it worked in a
test call" is exactly the kind of shortcut that's cheap now and expensive after a complaint or an
enforcement sweep. Register properly.

## What "Twilio sub-account, but for India" actually requires

This is the part worth knowing before treating per-org number provisioning as a future engineering task
sized like Twilio's — **it isn't the same shape of problem.** Twilio sub-account creation is one API call;
Indian number provisioning is a real-world verification process:

1. **DLT Principal Entity (PE) registration** — business KYC on a DLT platform (Tata DLT, Vilpower, or
   similar TRAI-approved platform). This is a business-verification process, not an API call.
2. **Sender ID / Header registration** — tied to the PE.
3. **Template registration** — every call script needs a pre-approved Template ID **before** it can be
   used. This means a new agent persona/script can't go live the moment it's written — it needs regulatory
   template approval first, which has real turnaround time.
4. **Number KYC, region/city-scoped** — Exotel's own docs confirm virtual number purchase is coupled to
   KYC approval status per region, with approval sometimes taking up to 24 working hours (their own
   stated SLA for flagging a stuck approval).

**The real product/architecture question, not yet decided:** does Weeber register as **one Principal
Entity**, with individual users operating as sub-brands/numbers underneath Weeber's own DLT
registration (faster user onboarding, Weeber owns the compliance relationship and liability) — or does
**each user need their own PE registration** (slower onboarding, but cleaner separation of who's
actually liable for what)? This is a real business decision with compliance and liability implications, not
just an engineering one — flagged here rather than assumed either way.

**Bottom line for the "self-serve, zero-setup onboarding" pitch:** in the US/NANP model, provisioning a
user's number is instant and API-driven. In India, it realistically involves a KYC/approval step with
real turnaround time (hours to days, not seconds) **at minimum for the first user**, and per-template
approval for every new agent script thereafter. This doesn't kill the pitch, but "zero setup" needs an
honest onboarding-flow design that accounts for a KYC step, not a promise that provisioning is instant.
