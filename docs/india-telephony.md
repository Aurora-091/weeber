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
Weeber specifically once real merchant volume starts. Building the compliance model around "it worked in a
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
Entity**, with individual merchants operating as sub-brands/numbers underneath Weeber's own DLT
registration (faster merchant onboarding, Weeber owns the compliance relationship and liability) — or does
**each merchant need their own PE registration** (slower onboarding, but cleaner separation of who's
actually liable for what)? This is a real business decision with compliance and liability implications, not
just an engineering one — flagged here rather than assumed either way.

**Bottom line for the "self-serve, zero-setup onboarding" pitch:** in the US/NANP model, provisioning a
merchant's number is instant and API-driven. In India, it realistically involves a KYC/approval step with
real turnaround time (hours to days, not seconds) **at minimum for the first merchant**, and per-template
approval for every new agent script thereafter. This doesn't kill the pitch, but "zero setup" needs an
honest onboarding-flow design that accounts for a KYC step, not a promise that provisioning is instant.
