# Product, Infra & GTM Report — 2026-07-16

One-time report, not a recurring format. Four parts: (1) recap of everything shipped this session,
(2) an infra/product resource inventory (external services + architecture pointers — doesn't
duplicate `architecture/` folder's existing code-structure docs, that's still the source of truth
for how the code is laid out), (3) a naming/feature audit with concrete findings, (4) GTM +
reliability research with actionable recommendations. Grounded in the actual repo + fresh web
research where noted — not assumed.

---

## Part 1 — Session recap ("morning report")

Everything shipped this session, in order (11 commits, `47cc3fc` back through `c85ccec` plus the
earlier Hindi/Hinglish + Workflow Canvas work already on `main` before this session started):

1. **Workflow Canvas doc cleanup** — resolved a real contradiction between two research docs,
   archived a dead build-prompt, fixed a stale TODO already done in code.
2. **Test baseline correction (ADR-056)** — the "38 pre-existing failures" cited across many prior
   sessions was a false signal from running `bun test` instead of `bun run test` (missing
   `--isolate`). Real baseline: 353/0, not 305/38.
3. **Global Compliance Engine Tier 0** (all 6 items) — closed the `BYPASS_COMPLIANCE` footgun,
   versioned + localized the AI/recording disclosure, refactored calling-window logic into
   jurisdiction packs (India/US), fixed a real US mini-TCPA gap (FL/OK/WA), built a generic
   purpose-scoped consent ledger.
4. **3 more insurance agent prompts landed** (appointment setter, post-sale welcome, feedback/NPS)
   — reviewed against real repo conventions before landing, not taken at face value.
5. **Marketing pages + Consent Ledger UI** — consent-ledger read endpoints + admin/merchant UI,
   real `/privacy`/`/terms` pages (previously dead links), fixed a genuine marketing overclaim
   about consent enforcement, added Insurance to the landing page's vertical grid (draft).
6. **Insurance India+US regulatory iteration** — all 5 insurance prompts hardened with dual
   IRDAI+NAIC citations and a new "replacement" guardrail; found and fixed a real bug
   (`flagGuardrailEvent` referenced in scripts but missing from `defaultTools`); added an automated
   regression test for that bug class.
7. **Insurance pre-launch blockers built** — India TRAI 1600-series dial-time gate, US
   producer-state-licensing dial-time gate (manual-entry MVP, NIPR-upgrade-ready schema).
8. **Insurance launch readiness resource doc** — the DLT/1600-series registration steps, advisor
   data-gathering guide, NIPR signup info.

**Net verified state as of the last commit**: typecheck clean across all 3 packages, oxlint 0
warnings/errors, `bun run test` 382 pass / 0 fail, production build succeeds.

---

## Part 2 — Infra & product resource inventory

**Superseded by `docs/resources.md`** (2026-07-17, written after Audit #7's real live-infra
access) — that doc has the current, verified service inventory plus real capacity numbers and
scaling reasoning. The table below is left as-is (historical record of what this report originally
said), but note one correction: it lists "File storage: S3-compatible" for knowledge-base uploads —
that was wrong even at the time, KB documents are chunked directly into Postgres, no object storage
involved. See `docs/resources.md` for the corrected version.

### External services this product actually depends on (from `.env.example`, cross-checked against real usage)

| Category | Provider(s) | Notes |
|---|---|---|
| Database | Postgres (Supabase-hosted per `DATABASE_URL`) | Drizzle ORM, migrations in `packages/api/drizzle/` |
| Hosting/deploy | Railway (`start:railway` script runs migrations then the server) | |
| Auth | Supabase Auth | JWT/JWKS validation in `app/middleware/supabase-auth.ts` |
| File storage | S3-compatible (`S3_ENDPOINT`/`S3_BUCKET`) | Knowledge-base document uploads |
| Cache/session | Redis (`REDIS_URL`) | Optional per ADR-026 — session storage, opt-in |
| Telephony | Twilio (platform + BYO), Plivo (BYO), Exotel (BYO, India) | Provider-abstracted, see `voice/telephony-transport.ts` |
| STT | Deepgram, Sarvam, ElevenLabs (Scribe v2 Realtime) | Per-agent configurable |
| TTS | ElevenLabs, Cartesia, Sarvam | Per-agent configurable, pronunciation dictionary support (ElevenLabs) |
| LLM | AI Gateway (model-agnostic) + Groq | `AI_GATEWAY_*` env vars |
| Email | Resend | Waitlist, auth emails |
| CRM integrations | HubSpot, Salesforce, GoHighLevel, Google Calendar | `voice/integrations/*.ts`, resilient-fetch wrapped |
| Cross-repo contract | `weebersh` (separate Shopify OAuth/webhook bridge repo) | `WEEBERSH_APP_URL`/`WEEBER_INTERNAL_SECRET` |

### Architecture — pointers, not duplicated here
`architecture/README.md` (+ `api-flow.md`, `data-model.md`, `user-flow.md`, `voice-orchestration.md`)
is the real source of truth for code layout and call flow — still accurate, don't re-derive it. In
one line: openvent self-hosts orchestration (code/DB/compliance/dashboards), the AI layer (LLM/STT/
TTS) and telephony layer stay cloud APIs you plug in, swappable, no lock-in.

### Product surface, current state
- **Verticals live**: Shopify/e-commerce, Clinic/local-service (both in `VERTICALS` on the landing
  page), Insurance (just added, draft copy pending your sign-off — 8 agent prompts, the deepest
  vertical build of the three).
- **Verticals "coming soon" with zero code scaffold** (confirmed by grep — no schema/agent-frame
  references at all): Hotels, Hospitals-as-a-separate-vertical-from-Clinic, Real estate, Logistics.
  Purely marketing placeholders today, not partially built.
- **Workflow Canvas**: admin builds graph-based automation templates, merchants get value-only
  customization today (full merchant-owned graph editing is planned, `workflow-canvas-v3-user-
  builder-plan.md`, not built).
- **Compliance engine**: jurisdiction-pack architecture (India/US), purpose-scoped consent ledger,
  insurance-specific dial-time gates (1600-series, producer licensing) — all built this session,
  on top of pre-existing DNC/calling-window/GDPR/HIPAA guardrails.

---

## Part 3 — Naming/feature audit (found during this session's grounding work, not exhaustive)

| Finding | Detail | Suggested action |
|---|---|---|
| `PUBLIC_MERCHANT_APP_URL` env var still says "merchant" | ADR-052 renamed "Merchant" → "User" everywhere else as the tenant-facing term (2026-07-13), this env var was missed | Low priority, cosmetic — rename in a future pass alongside any other env-var cleanup, not urgent enough to touch mid-flight env config alone |
| `@openvent/compliance` package name vs. `@weeber/api`/`@weeber/web` | Intentional — the compliance package is the open-source/open-core piece, kept under its original project name on purpose per the fork history | Not a bug, just flagging so it doesn't look like an oversight — confirm you still want this split-brand if the compliance package is ever published independently |
| Hotel/Hospital/Real-estate/Logistics verticals | Zero code exists — pure landing-page copy | Fine as-is for now (honest "coming soon," not overclaiming) — just don't let sales conversations imply these are further along than marketing copy |
| Insurance replacing "Enterprise" in the vertical grid | Done this session, draft copy | Still needs your sign-off (flagged in the code comment) before treating as final |
| `EnterpriseDialog` component copy ("Enterprise inquiry," "our enterprise team") | Now also used for the Insurance card's "Talk to us" button (shares the same dialog) | Minor — the copy is generic enough to not be wrong for insurance, but consider retitling if you want it to read as insurance-specific |

No other structural inconsistencies found in this pass — the rest of the naming (User vs Merchant,
Weeber branding, vertical terminology) is already consistent, a credit to the discipline in prior
sessions' ADRs.

---

## Part 4 — GTM + reliability research (fresh, 2026-07-16)

### Reliability — what competitors actually advertise, and the real gap here
Retell AI publicly advertises **99.99% uptime** built on cross-provider fallback — if their primary
LLM or TTS provider degrades, calls fail over to a backup automatically, not just fail. That's the
single most-repeated reliability claim across the competitive set researched (Retell, several
aggregator/review sites). **Weeber's current architecture doesn't have this today** — each call
uses one configured STT/TTS/LLM provider with no automatic failover if that specific provider has
an outage mid-call. Given the provider-abstraction work already exists (Deepgram/Sarvam/ElevenLabs
STT, ElevenLabs/Cartesia/Sarvam TTS, Gateway/Groq LLM all swappable per-agent already), an
automatic-failover layer is a incremental build on top of existing abstractions, not a rearchitect
— worth scoping as a real differentiator once the insurance compliance work settles, since
"resilient by default" is a genuine, provable claim to make against Vapi/Bland who don't
prominently advertise this.

### Pricing — where the market actually sits (researched, not assumed)
| Platform | Advertised/effective per-minute cost |
|---|---|
| Retell AI | ~$0.115/min all-in ($0.045 LLM + $0.055 platform + TTS) |
| Vapi | ~$0.05/min platform fee + separate LLM/TTS/telephony, effective $0.18–$0.33/min |
| ElevenLabs (as orchestrator) | $0.08–$0.24/min depending on tier |
| Aggressive self-serve market floor | ~$0.07/min |

Weeber's public pricing page deliberately shows **no dollar figures yet** ("full pricing set at
launch," waitlist locks in founder rates) — reasonable for a pre-launch waitlist motion, but worth
knowing the market's actual per-minute range now so founder pricing doesn't get set blind later.
Given Weeber's own COGS work (referenced in past sessions, ~$0.06/min all-in target), there's real
room to underprice this range while still hitting healthy margin — a genuine GTM lever once public
pricing goes live.

### Onboarding/activation — benchmarks worth targeting
Multiple sources in this space cite **1–2 hours** as a realistic "deploy for a new client" time for
a structured-intake SMB voice AI setup; more aggressive marketing claims ("5 minutes") exist but
read as aspirational rather than typical. Given Weeber's existing "same day" onboarding claim
(FAQ: "connect Shopify, pick a flow template, and you're taking calls"), that's already competitive
with the realistic end of this range — worth keeping honest rather than chasing the "5 minutes"
framing some competitors use, which risks an expectation mismatch during a real pilot.

### Trial/pilot conversion model — a real GTM decision point
Median free-trial-to-paid conversion across B2B SaaS broadly is **~8%**; paid pilots (2–4 week
scoped engagements) are a distinct, often higher-intent model than open free trials. Weeber's
current motion (waitlist → founder pricing, no explicit trial) sidesteps this question for now, but
it's worth deciding deliberately once out of waitlist mode: a scoped paid pilot (matches the
existing "founder cohort" framing already in the pricing FAQ) is likely a better fit for an
insurance-agency/clinic sales motion than a self-serve free trial, given the compliance-heavy setup
(licensed advisors, 1600-series numbers) that a trial user wouldn't have ready anyway.

### Concrete, prioritized recommendations
1. **Cross-provider failover for STT/TTS/LLM** — the single most differentiating reliability claim
   in the competitive set, and the existing provider-abstraction layer makes this an incremental
   build, not a rearchitecture. Worth scoping next after the insurance compliance work stabilizes.
   **RESOLVED 2026-07-17** — built on top of the existing STT/TTS provider-abstraction layer, no
   rearchitecture needed. STT: `voice/failover.ts` computes an ordered fallback chain
   (`resolveSttFailoverChain`/`resolveTtsFailoverChain`); `stream.ts`'s STT `onFatalError` now
   tries the next provider in the chain (reconnecting via `connectSttForCall`) before ending the
   call, and TTS failover retries the current turn on a fallback provider if the failure happens
   before any audio has played (text-sent-so-far is replayed to the new connection). LLM failover
   uses the AI Gateway's *native* model-fallback support (`providerOptions.gateway.models`) via the
   new `buildGatewayProviderOptions` helper — no custom retry wrapper needed there. All three are
   per-agent configurable (`org_agent_configs.sttFallbackOrder`/`ttsFallbackOrder`/
   `llmFallbackModels`, migration `0033_chubby_nicolaos.sql`), default to a platform-wide chain when
   unset (STT: deepgram → elevenlabs → sarvam; TTS: cartesia → elevenlabs → sarvam), and every
   failover increments the new `calls.providerFailoverCount` column so it's visible on the call
   record. 21 new unit tests (`voice/failover.test.ts`, `voice/llm/index.test.ts`).
2. **Decide the pilot/trial model deliberately** before exiting waitlist mode — a scoped paid pilot
   fits the compliance-heavy verticals (insurance, clinic) better than a pure self-serve trial.
   **DEFERRED 2026-07-17** — explicitly left undecided for now per founder call; revisit before
   exiting waitlist mode. No copy changes made.
3. **Use the real market pricing range** ($0.07–$0.24+/min) as a deliberate input when founder
   pricing is finalized, not set blind — there's real underpricing room given the existing COGS
   target. **DEFERRED 2026-07-17** — pricing page intentionally stays figure-free for now; this
   research range is logged here as the input to use whenever founder pricing is actually set.
4. **Keep onboarding claims honest** — "same day" is already competitive; don't chase "5 minutes"
   marketing framing from more aspirational competitors. **VERIFIED 2026-07-17** — no "5 minutes"
   (or similar) onboarding claim exists anywhere in `packages/web/src` today; the "same day" framing
   already in the pricing FAQ/Shopify flow is unchanged. No action needed.
5. **Fix the small naming items in Part 3** whenever convenient — none are urgent, all are cheap.
   **RESOLVED 2026-07-17** — `PUBLIC_MERCHANT_APP_URL` renamed to `PUBLIC_USER_APP_URL` (old name
   kept as a one-release fallback); Insurance vertical grid copy reviewed and approved as final;
   `EnterpriseDialog` now takes a `context` prop so Insurance's "Talk to us" button shows
   "Insurance inquiry" copy instead of the generic "Enterprise inquiry" text.
