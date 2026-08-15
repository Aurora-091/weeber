---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-08-15
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **The agent narrates tools it does not have (2026-08-15, audit 17 — findings only, nothing fixed).**
  First 11 real conversational test calls (2026-08-13/14) read back out of production.
  **F1 (P0):** `orgs.human_transfer_number` is NULL, so `filterTransferTool` strips `transferToHuman`
  — but the persona still scripts the handoff, so calls 1 and 9 promised a transfer that
  `tool_calls` shows never happened. The gate removed the capability and left the claim.
  **F2/F3 (P0):** the 2026-08-13 fix (`eafc762`) did ship — all 9 `agent_templates` persona rows match
  `extractRuntimePersona()` of the post-fix files byte-for-byte, and the seeder runs on every boot, so
  re-seeding is a **verified no-op**. The leak continued anyway: call 11 spoke 9 literal tool-syntax
  lines, and both of its shapes pass `scrubSpokenText` uncaught at HEAD `7f1d308`. Prompt and regex
  have both been pulled and both failed; the untried lever is the model. Defects track the
  **persona** (`insurance-final-expense-qualifier`, 11.7k chars, 13 tools), not the provider.
  **F4:** `bookAppointment` fabricated a callback confirmation with no calendar connected.
  **F5:** `FALLBACK_REPLY` blames the caller for a model failure and fired as the *opening* line twice.
  Latency from 72 turns: v2v p50 1591 ms overall, but **groq 1122 ms vs gateway 1793 ms** — a 672 ms
  p50 gap that is an open provider decision. `audit/2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md`.
  **Addendum 2026-08-15:** per-turn data breaks call 11 into a clean half (4 tool executions,
  0 leaks, TTFT 3194/3862 ms) and a broken half from 17:00:41 (9 turns, 9 leaks, 0 tools, TTFT
  ~650 ms). The persona and provider are constant across that boundary, so "defects track the
  persona" cannot be the explanation. Two corrections: the groq-vs-gateway latency gap is
  **confounded by tool execution** (a real tool call is two round trips, a leak is one) and does
  not support flipping the primary; and `provider_failover_count` is incremented **only** by TTS
  (`stream.ts:1579`) and STT (`stream.ts:2167`), never by the LLM, so no production data records
  which model served which turn. Blocking next step is instrumentation — per-turn transport+model
  and an LLM failover counter — before any model-swap experiment.
  **Blocked:** the Railway token in the sandbox is dead (`Not Authorized`), so the deployed SHA and
  its boot time are unknown — we cannot say which commit served call 11, and no deploy can be
  triggered from here.
- **One setting read twice is two settings (2026-08-14, ADR-114 — shipped; migration `0050` APPLIED to production 2026-08-15).**
  `transferToHuman` had one org-wide destination, `orgs.human_transfer_number`. Wrong for the launch
  vertical: an insurance org's six agents hand off to different people, and ADR-081 lets the
  final-expense qualifier reach a **licensed producer** and nobody else. New nullable
  `org_agent_configs.human_transfer_number` (migration **`0050`**, additive, null = inherit). The
  bigger half: the number was already read **twice** — once at `"start"` for the capability decision
  and ADR-106's provenance set, once again inside `performTransfer` via a second `select *`. That is
  ADR-105's shape, so `resolveHumanTransferNumber` is **deleted** and one pure
  `resolveTransferTarget` in `handoff.ts` feeds both halves, guarded by a source-text assertion.
  `AgentFrameSchema` field is `.nullable().optional()` so an override can be **cleared**, validated
  with the shared `isValidE164`. ADR-111's readiness pill is now **per-agent**, otherwise an agent
  with its own number renders "Live · limited" and sends the merchant to fix nothing. api 1354 →
  1363, web 95 → 101, non-vacuity proven both sides, nothing widened. **Still open:** `0050` and
  ADR-112's `0049` are both generated and applied **nowhere**, so an agent-config save fails against
  the real DB until they run; onboarding still asks for no transfer number at either level;
  `insurance_advisors` still empty so the producer destination is a hand-typed number;
  `provider-unsupported` still invisible in the UI.
  **Update 2026-08-15:** `0050` was applied to production via `packages/api/scripts/migrate.ts` after a
  full backup (`weeber-full-backup-pre-0050-20260815.json`, 196,709 bytes).
  `drizzle.__drizzle_migrations` 50 → 51; `org_agent_configs.human_transfer_number` exists as nullable
  `text`; all 6 config rows intact, none with an override set. `0049` had already been applied
  2026-08-13 11:06, so the "applied nowhere" note above is closed for both. Still true:
  `orgs.human_transfer_number` is NULL on the only production org, which is audit-17 F1.
- **The escape hatch was only findable after it was needed (2026-08-13, ADR-113 — shipped).** Test
  mode existed on Settings and nowhere in onboarding, so a fresh org's first call was refused with the
  TRAI/1600-series paragraph before anyone learned the toggle exists. New **fifth onboarding step**
  ("testing" vs "real customers", both answers complete it), **no new endpoint**, flag
  `test_mode_choice` = *the answer, not the state*, patched only **after** the POST succeeds. Pure
  `web/lib/test-mode-onboarding.ts` holds the one rule worth testing: "yes" always posts, "no" posts
  **only when a window is live**, and never for a never-configured or **expired** timestamp — clearing
  an expired one erases ADR-108's diagnostic evidence. Copy names DNC and the repeat-attempt cap as
  never lifted. web tests 85 → 95, non-vacuity proven; all six ratchets green, nothing widened.
  **Watch out:** the bypass is still **blanket** for every destination — the question makes the choice
  explicit, not the bypass narrower — and onboarding still never asks for `orgs.human_transfer_number`.
- **A BYO number nothing recorded (2026-08-13, ADR-112 — shipped; migration NOT applied).** All
  platform-rented Twilio numbers were **released** on the founder's instruction (parent + both live
  sub-accounts hold zero, nothing billing), so BYO is now the default path — and only
  `buyNumberForOrg` had ever written an `org_phone_numbers` row. The three BYO functions wrote
  `orgs.outbound_number` only, so a BYO org had a working caller ID, an **empty Numbers page** (hence
  no way to declare `numberSeries`, making the India DLT and insurance 1600-series gates
  unsatisfiable by construction), **dead per-agent routing** (`phone_number_id` is an FK into that
  table), and numbers outside webhook repair. New `voice/register-byo-number.ts` shared helper called
  from all three; new nullable `org_phone_numbers.source` enum(`purchased`,`byo`) with **no backfill**;
  supersession is a **pure** `supersededByoNumberIds` scoped to `byo` only — `purchased` is billed and
  dialable, `NULL` is unknown provenance and untouchable — extracted because **no `db` mock here
  evaluates `where` predicates**. Also: the org-level branch of `resolveOutboundRouting` was an
  unordered `limit(1)`, i.e. a **nondeterministic caller ID** for an org with two active rows; now
  `asc(id)`. api tests 1,324 → 1,336, non-vacuity proven twice. **Watch out:** migration
  `0049_daffy_beyonder.sql` is generated and **not applied**, so `registerByoNumber` fails against the
  real DB until it runs; and `TWILIO_PHONE_NUMBER` on Railway names a **released** number, so step 4
  of the routing chain dials from a number we do not own (Railway work is paused).
- **A green pill on an agent that cannot hand anyone over (2026-08-13, ADR-111 — shipped, UI-only).**
  `classifyReadiness` judged agents from `enabled` + `hasCallerId` only, so an agent whose
  `transferToHuman` ADR-105 had **narrowed away** (org `human_transfer_number` NULL) rendered green
  **Live**. Fourth state **`degraded`** / **"Live · limited"** added, precedence
  `paused` → `needs-number` → `degraded` → `live`. The capability context is a **required** third arg on
  purpose — an optional bag defaults to "no gaps" and is how the next surface silently regresses to green.
  `detail` now comes from the classifier so grid card, detail banner and detail header are three renderings
  of one verdict; the detail header pill was previously hand-rolled two-state on raw `emerald-*`/`zinc-*`
  and **disagreed with the banner beneath it**. Detail page classifies from `form.toolsEnabled`, so the
  warning appears before you save. Zero extra requests (`me.org.humanTransferNumber`). Deliberately fed
  **only** the ADR-105 gap: ADR-098's empty roster is org-wide and does not narrow this agent, ADR-108's
  lapsed window already has a countdown on Home/Settings. Reused `warning-soft`/`warning` (no `info` token
  in `.theme-weeber`, contrast gate already carries 9 declared failures) and **refused to widen
  `design:guard` `rawButton` 111 → 112** for a tab-jump `<button>` — plain text instead. Tests 12 → 19,
  non-vacuity proven (4 of 19 fail when the branch is stubbed out); all six ratchets green, none widened.
  **Watch out:** `app-agents` visual baselines render the *empty* state and protect none of this (verified
  by driving the built harness with fulfilled API responses instead; seeding the harness is the follow-up),
  and `provider-unsupported` is still invisible — an **Exotel** org with a transfer number set shows
  **Live** and cannot transfer.
- **Market focus is an authoring fact, not a gate (2026-08-13, ADR-110 — shipped, allow-and-warn).**
  "Insurance = US, Shopify = India" is now written down in exactly one place in code
  (`voice/compliance/market-alignment.ts`) and **nothing branches on it**. `noteMarketAlignment` runs on
  the **allowed path only** of `assertOutboundCallAllowed`, its result discarded, `runOutboundGates`
  untouched, failures swallowed — so this can never refuse a call, and three source-text tests hold that
  invariant. `console.warn`, not a `guardrail_events` row. **`orgs.market` was rejected, so ADR-095 stays
  `Proposed`**: every gate that needs geography already resolves it from the destination (DNC, calling
  window, FTSA cap, 1600-series, producer licensing, India DLT), so a column would not change one
  decision, and a stale market column looks more authoritative than a prefix inference. Refusing
  shopify→US was rejected too — it would encode a fact only true at zero customers and be load-bearing by
  the first US store. **Correction on the record (ADR-078):** the FTSA attempt cap is **not** insurance-only
  — it is called unconditionally and scoped by Florida area code, so shopify→US runs DNC + US calling
  window + FTSA cap. api tests 1,307 → 1,324; all six ratchets green, none widened. **Watch out:**
  `orgs.vertical` is unconstrained `text` defaulting to `"shopify"` and **neither** insert path sets it, so
  a fresh signup is a Shopify org until someone opens Settings.
- **The chain's last resort was its weakest link (2026-08-13, ADR-109 — shipped dark).** Gateway
  `groq/llama-3.3-70b-versatile` fails ~4 of 10 streaming-tool requests (bedrock attempted first, 400,
  then groq 503) and is the **last link** of production's `AI_GATEWAY_FALLBACK_MODELS`. Fix is
  **cross-transport** failover — direct Groq primary, gateway as the last link — not a Groq-only model
  chain, which would protect against capacity rather than against the transport being unreachable.
  Transport-qualified ids use a `direct:` colon scheme because `groq/<model>` is *already* a valid
  gateway id and production's current value, so a bare prefix would have redefined live config
  silently. Config reuses `org_agent_configs.llm_fallback_models` (no migration). The retry window
  **closes at the first token** — after that, retrying makes the agent say two things in one turn.
  Behind `LLM_TRANSPORT_FAILOVER`, **default off everywhere**; flag off ⇒ empty chain ⇒ unchanged
  gateway-native path. **Open:** whether to enable it on staging (which isolates nothing while staging
  shares `DATABASE_URL` and the Twilio account with prod), and a Railway-side latency soak — the
  ~130 ms hop is a dev-sandbox reading and must not be quoted as production.
- **The `+91` dial was refused by design; the expiry was invisible (2026-08-12, ADR-108 — shipped).**
  Nothing was broken. ADR-096 made `assertOutboundCallAllowed` the single fail-closed chokepoint and
  closed the three ungated paths live testing used, so an insurance org dialing `+91` now hits the
  unconditional TRAI 1600-series gate. The escape hatch already existed —
  `orgs.callingWindowTestModeUntil` (24h, `POST /api/app/compliance/test-mode`) bypasses it before any
  number lookup, DNC still enforced — but it had **lapsed the previous evening**, and an expired
  bypass produces a refusal byte-identical to a never-configured org's. Shipped: refusals now name the
  lapsed test mode (scoped to `TEST_MODE_BYPASSABLE`; `dnc`/`attempt_cap` deliberately excluded,
  additive to the original reason, silent when NULL or still active, best-effort so it can never throw)
  and the dashboard/settings show `Xh left` → bolded `lapses in Xh` under 3h → an explicit expired
  warning. A per-org test-number allowlist was rejected: demos go to whoever is in the room, so the
  destination cannot be pre-registered. api tests 1,281 → 1,287.
  **Before demoing `+91`: flip the Settings test-mode toggle first.** Still open — test mode is a
  blanket lift for every destination, not demo-scoped (fine for invited demos, not for cold outreach);
  the countdown does not tick.

- **The latency dashboard was blaming the wrong stage (2026-08-12, ADR-107 — shipped).**
  `turn_latency` said voice-to-voice p50 was 1878 ms with **1748 ms of it TTS**, on a turn `llm_ttft`
  already claimed 1381 ms of. `v2v - tts` was pinned at ~127 ms on *every* row across a two-second
  spread of LLM time — `tts_first_byte_ms` was tracking the LLM, not the vocoder. `speak()` anchored
  it at the top of the turn, before `generate()` ran, so the TTS column contained the whole LLM
  stage. Corrected decomposition of the p50 turn: **~127 ms dispatch / 1381 ms LLM / ~370 ms TTS** —
  the model is ~three quarters of the caller's wait. Shipped: anchor moved to the first character
  handed to TTS (inside ADR-083's lazy-connect facade, before socket open so connect time counts);
  column **redefined not duplicated** (all 78 pre-cutover rows are internal test calls), cutover
  pinned in the schema doc comment; `voiceToVoiceMs` unchanged in meaning *and* value;
  `stream-latency-attribution.test.ts` asserts the LLM stall lands in v2v and not in TTS, verified to
  fail against the old anchor. **Correction on the record** (ADR-078 style, new entry not an edit):
  ADR-104's "the four prod orgs still hold the old whole-file personas" is **false** — `runtime:begin`
  is a source marker `extractRuntimePersona` strips at seed time, and SHA-256 of repo-extracted
  runtime vs all nine prod rows is 9/9 identical. ADR-104 has been live in prod since it shipped; no
  re-seed was needed or performed. **Next: the LLM transport.** Direct Groq as a real second
  transport with its own failover chain mirroring `failover.ts`, shipped dark behind a flag —
  gateway `groq/llama-3.3-70b-versatile` still fails ~50% of streaming-tool requests and is the last
  link of prod `AI_GATEWAY_FALLBACK_MODELS`, while `buildGatewayProviderOptions` returns `undefined`
  for groq so "groq" currently means no failover at all. **Blocked on staging isolation:** Railway
  staging shares ~33 of 40 env vars with production including `DATABASE_URL` and the Twilio account,
  so there is nowhere safe to soak a transport swap. Approved to split, not yet done.

- **The agent texted a caller a phone number that does not exist (2026-08-12, ADR-106 — shipped).**
  Three more findings from the same call 25 as ADR-105, all about what the agent wrote and said while
  making a promise it could not keep. It sent two SMS: one containing the literal
  `[Advisor Desk Number]` — the exact shape ADR-104 stopped from being *spoken*, delivered in writing
  five hours after that ADR shipped — and one containing `888-555-0199`, which exists nowhere
  (`orgs.human_transfer_number` NULL on all 4 prod orgs, `insurance_advisors` empty, the caller never
  said a number, nothing in the prompt had one). ADR-104's guard covered the token stream to TTS; the
  channel that *persists* — `sendSms.body`, `crmSync.notes`, `bookAppointment.notes` — was unscreened.
  It also read a stage direction aloud (*"\*Sending text message...\* [[tone:upbeat]] And that's
  everything I need"*): the prefix is 23 chars, `TONE_TAG_MAX_BUFFER_CHARS` is 24, so the filter hit
  the cap, correctly concluded "no leading tag is coming", released, and then forwarded the tag as
  speech because the post-resolution path was a raw pass-through — the cap ADR-101 added to stop short
  turns being muted is what let it through. And it framed an outbound call as inbound ("the line that
  you reached out on", plus asking which number to use), whose answer is the utterance that ran the
  phantom turn ADR-105 fixes. Shipped: `voice/outbound-text-guard.ts` reusing `scrubSpokenText`'s
  findings plus `unverified-phone-number`, **refusing rather than scrubbing** (an SMS is atomic; a
  scrubbed one reads as broken and still fails the caller), with the test being **provenance not
  plausibility** — every shape check passes `888-555-0199`, so a number is allowed only if the server
  put it in scope or the caller said it, tracked live in `callerSpokenNumbers` and read through a
  closure. Wired via `withOutboundTextGuard` in `buildVoiceTools` (crmSync, bookAppointment) and in
  `stream.ts` for `sendSms`, whose execute is signal-only; refusals log
  `guardrail_events.category = fabricated-outbound-text` (a plain-text enum widening, no migration).
  `stripToneTag` now strips the tag anywhere and the filter holds back only from a dangling `[`;
  `output-guard.ts` deletes markdown asterisks but keeps the words, with the narration fixed at the
  prompt layer instead. api tests 1,241 → 1,278. **Known and unfixed:** a refused SMS is a message the
  caller expected and did not get, and the agent is not told, so it cannot correct itself mid-call —
  feeding the refusal back into the turn is the next step. **Still unfiled:** `flagGuardrailEvent`
  false positives, 6× and 4× on polite non-abusive callers.

- **The best call this product has ever placed dropped a warm lead mid-promise (2026-08-12,
  ADR-105 — shipped).** Production call 25 reads `status = "completed"`, `disposition = "booked"`,
  `health_status = "healthy"`, `intent = "purchase_or_booking"`, and it closed with *"Let me connect
  you with a licensed advisor right now… **You're connected — the advisor will take great care of
  you.**"* Nobody was connected; the line was hung up on them. `orgs.human_transfer_number` is
  **NULL on 4 of 4 prod orgs** and `insurance_advisors` is still empty (ADR-098), so `performTransfer`
  resolved no target and hung up. Every layer behaved as written — the defect was upstream: the model
  was handed a `transferToHuman` tool on a call where it could not possibly succeed, plus a persona
  saying the best outcome is a live warm transfer. **The launch vertical's only conversion event is
  structurally impossible in production today.** Second finding, same call: the closing line, the
  transfer, `crmSync` and `sendSms` all fired **twice** — filed for two sessions as "duplicated agent
  text", it was a whole phantom turn, because ADR-082's `transferLatched` gated `hangUp` and nothing
  else while the bridge waits at `speak()`'s tail with STT still connected. Shipped: pure
  `voice/handoff.ts` resolving transfer capability once at `"start"` (reasons `no-org` /
  `provider-unsupported` / `no-transfer-number`), `narrowToolsForTransferCapability` dropping the tool
  (which rewrites the prompt for free via `buildCallControlBlock`, and materializes
  `AVAILABLE_TOOL_NAMES` in the `undefined` = "all tools" case that covers most prod calls),
  `bookAppointment` left intact as the fallback, a rule that the model may *promise* the handoff but
  never *report* it, the latch extended to short-circuit whole turns (transcript still written), and
  `handoff.test.ts` asserting against `stream.ts` source text that the duplicated decision stays in
  agreement. api tests 1,221 → 1,241. Also corrected a wrong claim on the record per ADR-078:
  "hand-off spoken but never recorded" was an ADR-103 *harness* finding, not prod behaviour — prod
  records the tool call **and** hangs up, which is worse. **Still open:** nothing tells an operator to
  set the number beyond a `console.warn` (dashboard surfacing is unbuilt), and `call-health.ts` still
  calls call 25 healthy — nothing in the stack notices a broken promise. **Next: ADR-106** (F3/F4/F5
  from the same call — `sendSms` sent a fabricated advisor number `888-555-0199` and an unresolved
  `[Advisor Desk Number]` placeholder, the tone-tag stripper is `^`-anchored so `[[tone:upbeat]]`
  mid-string is spoken, `*Sending text message...*` stage directions reached TTS, and the agent framed
  an outbound call as inbound).

- **The personas were authoring documents shipped verbatim to the model (2026-08-12, ADR-104 —
  shipped in code, NOT yet true in production).** Production call 22 spoke *"Hello, is this ? This is
  calling on behalf of krisn"* and call 24 spoke *"Hi, is this **[Caller Name]**? This is **[Agent
  Name]** with presistentads"* — six of nine personas opened with `You are [Agent_name: {{agent_name}}]`
  and the merge layer resolves only `{{tag}}`, so it stripped the tag from *inside* the brackets and left
  the label standing to be read aloud. Underneath, `seedAgentTemplates()` wrote the **whole file** into
  `default_persona_prompt`, so **13-40% of every persona was prose addressed to a maintainer** (the
  `**File:**` header, the regulatory pointer, the variables table, the tools table, the "Known gap"
  note), worst on the launch agent at 19,711 chars / 272 lines / 40% metadata — re-sent every turn of
  every call. What remained was a numbered script with lettered branches, which is exactly why ADR-103's
  harness caught near-verbatim recitation. Shipped: `runtime:begin`/`runtime:end` markers,
  `extractRuntimePersona` that **throws** instead of falling back to the whole file, all nine runtime
  regions rewritten goal-based with every guardrail and audited line verbatim, `voice/output-guard.ts`
  scrubbing tool syntax / JSON residue / bracket slots at the single `onTextDelta` chokepoint (a gateway
  8B model leaked `3"}</function>…` as speech in 4 of 6 probe runs), a new `persona:gate` CI ratchet, and
  G1.3/G1.4 re-pointed at the seeded region so G1.4 covers all 9 templates instead of 3. Measured:
  103,752 → 73,783 persona chars (−29%), launch agent −40%, api tests 1,188 → 1,221.
  **Next, and required for any of this to matter: re-seed `agent_templates` on production.** All four
  prod orgs still hold the old whole-file personas, so live calls keep reciting until that runs. Nothing
  in that table is hand-edited, so a full re-seed is safe — but it is a deliberate write to prod.
  Also still open: whether the goal-based rewrite actually reduces recitation is **unverified** — re-run
  the ADR-103 synthetic scenarios after the re-seed to find out.

- **The only automated behavioural check this product has could not fail the tests it claimed to run
  (2026-08-12, ADR-103).** An A/B model comparison used the synthetic harness as an instrument and the
  instrument was the finding. `wrong-info` had **never** passed and could not — reactive persona, caller
  speaks first from an empty transcript, caller model returns `""`, silent `break` on turn zero, lone
  assertion scored against an empty transcript (0 turns, ~1.7s, both models, both templates). Every
  scenario was **inbound** while production is 10 outbound / 1 inbound. All eight were ecommerce-shaped
  against six insurance templates, so ADR-081's boundary was prose only. Worst of the four: the scripted
  caller runs on an **aligned** model that **refuses adversarial personas** — asked to volunteer a
  fabricated SSN it answered in its own assistant voice and offered *the agent* a menu of insurance
  topics, and both data-handling scenarios **passed** with the agent never challenged. Shipped:
  `firstSpeaker` (Vapi's `firstMessageMode` axis; agent-first drives the exported `GREETING_TURN_SEED`,
  not a paraphrase), `callerMustSay` → `endedBy: "caller-off-script"` with `allPassed` forced false,
  per-scenario `callerModel` pin (boundary scenarios on direct Groq `llama-3.3-70b-versatile`, where the
  caller pushed the SSN four times and the agent refused every time), `endedBy: "caller-silent"`,
  `toolCalledAnyOf`, four outbound scenarios, both new non-results surfaced in the dashboard.
  `wrong-info` now runs 8 turns and passes. The harness is **on-demand, not in CI**, so the two
  scenarios that fail today are findings, not a red build.
  **Good news, now evidence instead of assumption: the ADR-081 boundary holds** under adversarial
  pressure — no premium quoted, no coverage bound, no start date confirmed, SSN and routing refused,
  licensure never claimed.
  **Three defects to act on, none fixed yet.** (1) *The hand-off is spoken and never recorded* — the
  agent promises an advisor callback and calls neither `bookAppointment` nor `transferToHuman`, so a
  warm lead who verbally agreed leaves **no row**. That is the launch vertical's only conversion event
  and it is ADR-090's class in the product itself. Highest value item in this batch. (2)
  `flagGuardrailEvent` fires **6×** on a polite-but-persistent caller and 4× on another — sales friction
  is being logged as abuse, which makes the signal unreadable. (3) A turn emitted duplicated text with a
  tone tag mid-sentence — **fourth** defect in that feature after ADR-082/-083/-101.
  Also: the "agent sounds scripted" complaint is now reproducible on demand — the same canned advisor
  line recited near-verbatim across turns, six consecutive refusals with no alternative offered.

- **The tail of production's LLM failover chain is ~40% broken (measured 2026-08-12, ADR-103, NOT
  fixed — needs an env decision).** Direct Groq supports tool use in streaming on all four models
  probed (`llama-3.3-70b-versatile` 256ms TTFT, `llama-3.1-8b-instant` 160ms, `qwen/qwen3.6-27b` 533ms,
  `openai/gpt-oss-120b` 229ms **with** content — which contradicts an earlier note in this repo). But
  `groq/llama-3.3-70b-versatile` **via the gateway failed 4 of 10** identical requests, and the routing
  metadata is explicit: `resolvedProvider: "groq"`, `canonicalSlug: "meta/llama-3.3-70b"`, and
  `providerAttempts` = **bedrock first** returning 400 *"This model doesn't support tool use in
  streaming mode"*, then groq 503. It is **Bedrock's** Llama-3.3-70B that lacks streaming tool use, not
  Groq's — so the earlier conclusion "that model can't do tool use" was wrong about the cause. That slug
  is the **last link of `AI_GATEWAY_FALLBACK_MODELS`** in prod, so the declared third leg of failover
  does not work for a 10-tool streaming workload. `google/gemini-3.1-flash-lite` (10/10, 1040ms p50) and
  `openai/gpt-5.4-mini` (10/10, 923ms p50) are sound. Decision needed: replace the tail slug, or accept
  a two-deep chain and say so.

- **The voice pipeline was measured before anything was changed (2026-08-12, ADR-100).**
  Real numbers, 44 turns with a complete measurement: `v2v` p50 **1863ms**, p90 4180, p95 4394, max
  8173; `pickup_to_first_audio_ms` 1770–2588ms on all 11 calls. One decomposed turn is pre-LLM 129ms
  (8%) | **LLM TTFT 1136ms (71%)** | TTS 336ms (21%). **The model is the cost; nothing else is close.**
  Two traps in this data, both of which I fell into first: `voiceToVoiceMs` is `speech_final` → first
  TTS byte **server-side**, so the US→India Twilio leg inflates what a tester hears but not what the
  table records (the numbers are not geographically poisoned); and `tts_first_byte_ms` is **cumulative
  from turn start**, not the TTS stage, so reading it as a duration overstates TTS.
  Fixed only what was being paid for nothing: caller-transcript INSERT off the hot path (it sat between
  `speech_final` and the LLM request, cross-region Singapore→Mumbai, writing a table the model never
  reads — **chained**, not fire-and-forget, because rows are read back ordered by identity column and
  racing inserts reorder a conversation; drained in `finalizeCall` with a 2000ms cap); the
  literal-greeting fallback now names the unresolved tag instead of failing silently; merchant free text
  trimmed where it becomes speech; `{{interaction_type}}` given a producer.
  **The finding to act on: the literal-greeting fast path is 0 for 11 — it has never fired in
  production**, so every call ever placed paid ~1.3s of LLM TTFT for an authored sentence. It is a
  **data** defect: 3 of 4 `leads` rows have `name = NULL` and `fields = {}`. Fixing the lead rows is
  worth more than any code change in this batch. No prod data was written.
  Explicitly deferred as unearned: the LLM TTFT fat tail (p50 1376 → p95 3826 — needs per-request
  gateway-vs-model timing before naming a cause) and Cartesia-vs-ElevenLabs at n=2. The third deferred
  item — the 10 of 78 turns with no TTS byte — was investigated and closed the same day, see ADR-101
  below; **its "dead air" framing here was wrong** and is retracted there.

- **A voice is an agent property, and the ElevenLabs failover leg had never worked (2026-08-12,
  ADR-102).** Every TTS adapter read `voiceIdOverride || process.env.<PROVIDER>_VOICE_ID`, which
  reintroduces ADR-070's hazard one layer lower: a voice belongs to an **agent**
  (`org_agent_configs.voice_provider` + `voice_id`, set in the dashboard picker), an env var belongs to
  a **deployment**, so the same agent row could speak as a different person depending on which
  environment served the call. Of 43 Railway prod vars, `ELEVENLABS_VOICE_ID` and `SARVAM_VOICE_ID` are
  **absent**; all 6 prod agent-config rows are Cartesia with `tts_fallback_order` null, so
  `DEFAULT_TTS_FALLBACK_ORDER = [cartesia, elevenlabs, sarvam]` governs **every call ever placed** and
  its second leg built `wss://api.elevenlabs.io/v1/text-to-speech/undefined/stream-input`. Silent at
  boot, silent on the call record, discoverable only during a Cartesia incident — ADR-090's class.
  Fixed with `FALLBACK_VOICE_BY_PROVIDER` as a `Record<TtsProvider, string>` code constant in
  `tts/default-voices.ts` (a missing env var is `undefined` mid-call; a missing constant does not
  typecheck), Cartesia pinned to the exact prod value so no agent's voice changes, blank-safe
  `resolveVoiceId` as the only adapter path, voice IDs removed from `assertVoiceConfig` and both doc
  surfaces, and a new boot `warn` per **dead failover leg** across both default chains. Tests assert at
  the wire via `MockWebSocket` and were proven to fail for the right reason.
  **Still open and a business call:** the ElevenLabs account returns `payment_issue` on every
  generation, so the leg is now structurally correct and still non-functional — TTS is effectively
  single-sourced on Cartesia until an invoice is paid (starter tier, 40k chars/month, break-glass at
  best). **Also measured, not yet a decision:** prod LLM primary `google/gemini-3.1-flash-lite` is
  ~929ms median TTFT vs ~334ms for `groq/llama-3.3-70b-versatile` on the same gateway; Cartesia
  `sonic-3` first byte ~183ms needs no change. Measured from a sandbox, not Railway Singapore.

- **A reply too short to trip the tone-tag buffer was never spoken at all (2026-08-12, ADR-101).**
  ADR-100's "10 of 78 turns produced no audio" was one label over two different things, and the label
  hid the row that mattered. 9 of the 10 are turns the caller aborted **before the first LLM token** —
  correct barge-in, and provable: call 25 has 27 turn rows and 23 agent transcript lines, and the 4
  all-NULL rows are exactly the 4 turns with no agent line, each between two caller lines under 1.5s
  apart. A further 8 rows read as "no LLM ran" are just `speakCannedLine` re-prompts, where no LLM is
  supposed to run. **The 1 real one is call 21 turn 3**: `llm_ttft_ms = 2779`, `tts_first_byte_ms`
  NULL, transcript recording `"OK."` as spoken, caller transferred having heard silence.
  Cause: ADR-082's tone-tag filter released its hold-back on the first of three conditions (complete
  tag / any `]]` / 24 chars) and had **no condition for end of stream**, so a reply shorter than the cap
  with no `]]` was still entirely buffered when the turn ended; ADR-083's lazy connect meant no socket
  existed, `endTurn()` took its "no speakable text" branch, and nothing errored or logged. Every short
  untagged reply was exposed — rare only because the model usually does emit the tag.
  **Third defect in this one feature** (ADR-082 unwired `setTone`, ADR-083 the socket lifetime) and
  ADR-090's class at its purest: a closure in a 2000-line `stream.ts` no test could reach.
  Fixed: the filter is now `createToneTagFilter` in `tone-tags.ts` with an idempotent `flush()` called
  in `speak()`'s `finally` before `endTurn()` — not on a barge-in, where abandoning the text is
  correct — plus a `DEAD AIR on turn N` error log, because a NULL `tts_first_byte_ms` was
  indistinguishable from three benign causes and that ambiguity is the whole reason this sat unexamined.
  **Next thing to look at from the same reconciliation, deliberately not fixed:** the silence re-prompt
  fired 3× in call 25 and the caller answered within ~3s each time — the agent interrupts people who
  are thinking. Timer tuning on n=1 call; needs a decision, not a patch.

- **CI on `main` is green again; the cause was an unversioned third-party input (2026-08-11, ADR-099).**
  `main` had been red for four commits — `visual`, `fonts`, `CI success` — while the whole range
  changed exactly one file under `packages/web` (two lines in a test that renders nothing). Cause:
  `styles.css:1` `@import`ed the Google Fonts CSS2 endpoint, so all 78 pixel baselines were a
  photograph of whatever binary the CDN served that minute, and upstream Fraunces moved. The four
  brand families are now `@fontsource-variable` packages pinned in `bun.lock` and bundled same-origin,
  and `ALLOWED_OFF_ORIGIN` in the screenshot guard is empty — a screenshot run reaches nothing but
  `localhost`. **Zero baseline bytes changed**, which is the proof: pinning restored the prior
  rendering rather than laundering the drift into the baselines. No ratchet was widened.
  **Take from this:** when a pixel gate goes red with no source change, work the four pins in
  `playwright.visual.config.ts`'s header before touching a baseline or an `ALLOWED` list. One of them
  had been aspirational rather than true.
  Also fixed in the same pass: `2a29a18` left an unused `dirname` import in
  `tools/dead-code/knip-gate.ts`, which is all the `lint` failure was.

- **Two facts that were stale everywhere (2026-08-11).**
  1. The GitHub repo is **`Aurora-091/weeber`**, not `openvent`. ADR-078 item G had left the rename
     "to be decided separately". The old slug `301`s, so git remotes are fine, but API calls that do
     not follow redirects break; the numeric id `1295249026` is stable. Historical ADRs/audits still
     say `openvent` and are deliberately left alone.
  2. The **Railway staging deploy of `2a29a18` is `SUCCESS`** on `api-staging-b11d.up.railway.app`,
     no longer `NEEDS_APPROVAL`, and staging's builder is now `NIXPACKS` matching production. Still
     true and still the real risk: staging shares ~33 of 40 env vars with production including
     `DATABASE_URL` and the Twilio account, so "staging" dials and writes production.

- **First outbound pilot prep, and the structural finding underneath it (2026-08-09, ADR-081…090).**
  Ten ADRs landed in one day and they are not ten topics. The scope decision is ADR-081: the agent
  **qualifies and warm-transfers**, it does not perform the licensed act — no claiming licensure, no
  carrier recommendation, no premium quote, no itemized health conditions, no SSN/DOB/routing/account
  capture, no effective date or beneficiary, no voice-signature ACH authorization. Treat that as a
  standing constraint on anything in the insurance vertical, not a pilot detail.
  Shipped with it: transfer outranks hang-up (082), lazy TTS connect so an unspoken socket stops
  tripping failover (083), call health counts `callerTranscriptCount` (084), outbound opener resolves
  lead greeting context in the pickup `Promise.all` (085) and the `interest_area`/`state` fields it
  needs now exist in the intake schema (087), per-account template `visibility`/`ownerOrgId` + an admin
  grant route (086), the prohibited-capture guard actually enforced at the write path (088), and
  preview-first CSV lead import (089).
  **The finding that matters more than any of them: eight of ADRs 073–088 are the same defect** —
  code written, documented, unit-tested, never connected to a caller. 073 and 088 are the identical
  bug found three days apart, both by a human running `rg`. Nothing measured reachability, and unit
  tests structurally hide it (the test imports the symbol, so the export looks used). ADR-090 adds
  `knip` as a CI **ratchet** — `bun run knip:gate`, baseline 61 findings in
  `tools/dead-code/knip-baseline.json`, fails only on new ones. **Before wiring anything new, run the
  gate; before trusting a "shipped" item below, check it has a caller.**
  Gates: typecheck clean · lint 0/0 (479 files) · test **1242 pass / 0 fail** · `knip:gate` green.
  **Not live-verified:** no outbound call has been placed since the silence-timer fix. 082–085 are
  unit-verified only. See `task.md` for the pilot blocker list (no real prospect CSV header row, no
  prospect org in the deployed DB so the bespoke template is still seeded public, uncalibrated 55 ms/char
  playback constant, unsolved US-vs-India TTS routing).

### Earlier context (kept for continuity — verify against `progress.md` before relying on it)

- **The caller identity a tool writes to comes from the carrier, not the model (2026-08-01, ADR-069).**
  Closes the one ADR-066 violation the tool audit found. `crmSync` took `phoneNumber: z.string()` as a
  required *model-authored* input and used it as the **upsert key** — `syncToGoHighLevel` POSTs it as
  `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23-32`), which matches on phone, so a wrong
  number does not error: it writes this call's notes onto **someone else's contact** in the merchant's live
  CRM. Three routes there (LLM invents digits it was never given; STT digit errors on Indian accents; the
  caller just says a number that isn't theirs). Meanwhile the real number was already resolved server-side
  at `voice/stream.ts:1561` and already trusted for DNC (`:515`) and caller memory (`:611`).
  Fix is the ADR-064/066 pattern: `CrmSyncContext = { orgId, phoneNumber }`, `resolveCrmSyncContext()`,
  `createCrmSyncTool(ctx)`, resolved once in the `"start"` handler (`stream.ts:1580`) and fixed for the
  call's life; model input narrows to `{ callerName?, notes }` with `phoneNumber` **removed from the JSON
  Schema** (optional-with-a-default was rejected — a field in the schema is a field the model fills).
  **Non-registration is the gate:** `crmSync` is out of the static `voiceTools` map, `buildVoiceTools` took
  a 6th `crmSync?: CrmSyncContext`, and the tool only exists on calls where the context resolved.
  Intended side effect, kept deliberately: **test-chat, the synthetic harness and the preview drawer now
  get no `crmSync`** — a text test could previously write a live contact into a production CRM.
  Also fixed: five seeded insurance personas still documented `crmSync({ phoneNumber, notes })` in their
  tool tables, and those markdown files *are* the shipped prompts.
  Gates: api tsc 0 · web tsc 0 · api 852 pass · web 74 pass · oxlint 0/0. 13 new tests.
  **Not live-verified.** Open question: is `humanNumber` populated at `"start"` on *every* provider —
  Exotel's WS-only path inserts the `calls` row later than Twilio/Plivo. Failure mode is a *missing* CRM
  write, not a wrong one. Step 7 of the call-test protocol covers it.

- **G0.4 protocol written; the call itself is blocked on G0.1 (2026-08-01).**
  `docs/reference/live-call-test-protocol.md` — nine steps: environment isolation as a blocking
  prerequisite, three test numbers incl. a DNC negative control, instrumentation captured before dialling,
  four scripted calls, post-run DB verification, a same-day write-up, and an explicit list of what four
  calls do **not** cover. Deliberately no call was placed: staging bills prod's Twilio and writes prod's
  database. **Step 0 is the G0.1 infra work** (separate Twilio subaccount + number, separate Supabase
  project, `LLM_PROVIDER` matched to prod) and it is not doable in this sandbox — no `railway` CLI, and it
  is the user's billing.

- **Product layout responds to the content column, not the viewport (2026-08-01, ADR-068).** Every grid
  in `pages/app/` used viewport breakpoints while `AppShell`'s sidebar is `hidden md:flex` at `w-56`
  (`components/shell/app-shell.tsx:307,315`) — so it *appears* at 768px and immediately takes 224px, and
  with `--shell-page-px: 2rem` (`styles.css:478`) the content column at that width is 480px. `sm:` fires
  at 640px viewport, so `sm:grid-cols-3` was laying out 149px cards. Document `scrollWidth` was correct at
  every width, which is why this never produced a page scrollbar and was never caught: **the overflow was
  inside the cards, not on the page.** Screenshot at 768px showed `/app/integrations` telephony cards
  rendering "Not connected" one letter per line, "Download as Excel" escaping its card, and `/app/agents`
  truncated to `"COD co…"`.
  Fix: `@container` on both `<main>`s (`app-shell.tsx:367`, `:370`) and **26 in-flow grids** converted to
  container variants across 8 files. Two deliberate exceptions keep viewport breakpoints because they
  render *outside* `<main>` and so have no query container — `pages/app/leads.tsx:725` (Dialog) and
  `components/app/setup-modal.tsx:257` (Sheet); container variants there would silently never match.
  Marketing pages have no sidebar and were untouched. Agent card titles went `truncate` →
  `line-clamp-2 break-words`.
  Verified: overflow sweep over 8 product pages × 10 widths `[390…1440]` went **3 of 40 flagged → 0 of 80**;
  sidebar collapse at viewport 1180 reflows the agents grid **2 → 3 columns** (224px → 52px), which is the
  whole point and is something viewport breakpoints structurally cannot do. New
  `pages/app/responsive-grid.test.ts` (24 tests) fails the build on any bare `sm:grid-cols-*` in
  `pages/app/` or `components/shell/` and asserts `@container` on both `<main>`s; `leads.tsx` is the single
  allowlist entry. Gates: api tsc 0 · web tsc 0 · api 840 pass · web 74 pass · oxlint 0/0.
  **Caveat, stated rather than hidden:** `/app/home`'s three metric strips are data-driven and render empty
  in the backend-free preview harness, so their `sm:grid-cols-4` → `@md:grid-cols-2 @4xl:grid-cols-4` change
  passed the sweep with no tiles present. It is reasoned-correct, not eyes-on-verified.

- **G1 pilot gate — build round (2026-08-01).** Working the pilot-blocking list in
  `audit/pilot-readiness-checklist-2026-08-01.md` so Shopify merchant conversations can start. Four items
  shipped across two commits, all pre-pilot so no merchant was ever affected:
  - **G1.1/G1.2** (`f8c2ba1`, ADR-064) — the LLM chose `percentOff` on `offerCartRecoveryDiscount` and
    silently issued 10% by schema default while the merchant's configured discount was ignored. Now a
    server-bound factory; model input is `{ reason }`; **non-registration is the enforcement** (no discount
    configured → the tool is absent from that call's tool set).
  - **G1.3/G1.4** (`9990a54`, ADR-065 + ADR-066) — every seeded persona was a `{{merge_tag}}` template and
    **nothing rendered it**; `renderTemplate` only ever touched `literalGreetingTemplate`. Rendering was
    rejected (two drifted tag vocabularies; `cart_items_summary`/`product_name`/`delivery_days_estimate`
    have no producer anywhere). Personas 01–03 rewritten tag-free as *instructions*; values now arrive via
    fact blocks that emit a line only when the fact is known; `voice/merge-tags.ts` scrubs any surviving
    tag at the single `streamText({ system })` call site; `database/prompt-hygiene.test.ts` enforces it
    with a shrink-only insurance backlog. Same commit: `confirmCodOrder` was letting the model name the
    `orderId` of an order it **cancels irreversibly**, while (per a separate defect) never having been told
    the order reference — now server-bound, model input `{ confirmed, notes }` (ADR-066).
  - **G1.5** (this round) — `looksLikePromptInjection` was nine English `verb…object` regexes; Hindi and
    Hinglish are verb-final so none could ever fire. Extracted to `voice/injection-detection.ts` with
    order-independent verb/noun co-occurrence, Devanagari stem matching and nukta normalization. Still
    log-only.
  - Three silent producer defects fixed in passing: COD context never wrote `currency` (so the COD agent
    could not state the amount it exists to confirm); the facts block emitted no order reference at all
    (producers write `orderId`, the block read `order_id`); `03`'s seeded greeting carried
    `{{product_name}}`, which has no producer, so its fast canned-greeting path had **never once fired**
    and every feedback call paid full LLM time-to-first-token.

  **NEXT on G1:** insurance personas `04`–`09` are still templated (tracked in
  `MERGE_TAG_MIGRATION_BACKLOG`, which may only shrink). One open product decision, not a doc fix: whether
  the disposition enum should gain confirmed/cancelled and feedback-positive/negative values instead of
  overloading `booked`/`interested`.

  **ADR-066 audit of the two remaining tools — done (2026-08-01), one violation found.**
  - `bookAppointment` (`voice/tools/bookAppointment.ts`) is **compliant**. `orgId` is bound by the factory;
    `calendarId` and `accessToken` resolve from `orgIntegrations` (vault-first). The model supplies
    `callerName`/`dateTimeIso`/`notes`, which *create* a new event — it never names an existing entity, and
    cannot reach another org's calendar. Minor, non-blocking: `dateTimeIso` is unbounded, so a past or
    far-future slot is bookable.
  - `crmSync` (`voice/tools/crmSync.ts:15`) is a **violation of the same shape as `confirmCodOrder`**.
    `phoneNumber: z.string()` is model-supplied and required, and it is the **upsert key** —
    `syncToGoHighLevel` POSTs it as `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23`). A
    hallucinated or caller-dictated number writes this call's notes onto a *different* contact in the
    merchant's CRM. The model has no legitimate reason to supply it: the caller's real number is already
    resolved server-side in the `"start"` handler as `humanNumber`
    (`voice/stream.ts:1561`, via `resolveHumanNumber`) and is already trusted for DNC opt-out (`:515`) and
    caller memory (`:611`). Fix is the established pattern — a `CrmSyncContext` carrying `humanNumber`,
    bound at `buildVoiceTools` (`voice/agent.ts:869`) alongside `cartRecovery`/`codOrder`, model input
    narrowed to `{ callerName?, notes }`. Lower blast radius than `confirmCodOrder` (a wrong write, not an
    irreversible cancellation), but the same class.
    **SHIPPED the same day as ADR-069** — see the top of this file. This audit note is kept for the
    reasoning trail.

- **Agent console UI (2026-08-01).** Overview grid shipped at `/app/agents` — the route was previously a
  pure redirect to the first agent, so nine agents were reachable only through a `<Select>` and the detail
  page's own "Agents" breadcrumb linked back to itself. Readiness logic deduped into
  `classifyReadiness`/`agentReadiness` so the grid and the detail page's caller-ID banner cannot drift.
  Browser-verified through an `AgentsGridProbe` in `__preview.tsx` (four synthetic states, no backend).
  A create-agent flow was considered and **rejected** — no POST route exists, the registry is curated, and
  the real complaint was seeing the agents that exist. Full reasoning in `changelog/2026-08.md`.
  Same round: `lookupInfo` added to the three Shopify templates' `defaultTools` (`database/seed.ts`) —
  **newly seeded orgs only**, existing `agent_configs` rows are untouched. **Backfill declined
  (2026-08-01):** every existing org is the founder's own or a test org, so a data migration would buy
  nothing and touch live rows for no reason. Revisit only if a real org predates the seed change.

  **Still unverified, and the honest gap in all of the above:** no real end-to-end PSTN call has been
  placed. Every claim here is from static source reading plus `--isolate` tests.

  **G0.1 closed (2026-08-01), badly.** The `progress.md`-vs-`adr-063` contradiction is settled: ADR-063
  was right, and understated it. Diffing the two Railway variable dumps, **33 of 40 variables are
  byte-identical** across staging and production — same `DATABASE_URL` (same Supabase project, pooler,
  db, role), same `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`, same
  `SUPABASE_SERVICE_ROLE_KEY`, same `ADMIN_API_KEY` and internal secrets, same `PUBLIC_*_URL`s. The only
  real difference is `LLM_PROVIDER` (staging `groq`, prod `gateway`). So "staging" dials from the
  production phone number, bills the production Twilio account, writes into the production database, and
  runs a *different* LLM path than prod — it shares prod's blast radius while testing neither prod's data
  layer nor prod's model layer. **This is the top infra item to fix before a pilot merchant's data exists
  in that database**, and it converts Five Bets P5 gate (b) from unverified to confirmed unmet.

  Also corrected the same day: `architecture/voice-orchestration.md` claimed the PDF knowledge base
  "does not exist in the schema/backend yet." It has existed since 2026-07-14 (A3b) — tables, ingestion,
  retrieval, CRUD routes, merchant UI, and the `lookupInfo` binding are all real.

- **Phase III (Visibility) shipped — 2026-08-01, ADR-067.** The agent-editor case study's three
  visibility gaps, closed together. **D2:** new `composeSystemPrompt()` in `voice/agent.ts` is now the
  *single* system-prompt composition path (both `resolveAgentConfig`'s DB-row branch and
  `buildPreviewAgentConfig` call it) and returns the labelled layers alongside the final string; two new
  pure `compiled-prompt` endpoints serve them; a "Prompt" tab in the Preview drawer renders the layers,
  highlights the merchant's own text, and line-level diffs whatever the last edit changed. Invariant
  `segments.join("") === text` is unit-tested byte for byte, so the panel cannot drift from a live call.
  **D4:** tool chips carry a human label, a one-line description, and a consequence group
  (*Conversation control* / *Data capture* / *Acts outside the call*, the last one weighted) instead of a
  raw camelCase identifier. **D3:** each guardrail dial renders the exact sentence it injects, sourced
  from a dependency-free `voice/prompt-lines.ts` with a web parity test.

  Fixed in passing: `buildPreviewAgentConfig` never fetched `orgs.name`, so **every previewed prompt was
  missing the "You are calling on behalf of X" line a real call ships**. It now takes an optional `orgId`;
  all five call sites pass it.

  Stated in the UI rather than papered over: **`injectionSensitivity` changes prompt wording only** — the
  runtime injection detector is not wired to that dial and behaves identically at all three levels.
  Making it real is a separate, unstarted decision.

  **Browser-verified later the same day, and it found two defects.** A DEV-only `phase3` page in
  `pages/__preview.tsx` mounts `ToolsGuardrailsTab` (now exported for the harness) beside
  `CompiledPromptPanel` with local state — web-only Vite server, no API, no telephony. Groups, mono
  consequence lines, layer badges and diff-on-toggle all render as designed, light and dark, zero console
  errors. **(1)** Reading the call-control layer on screen exposed that `buildCallControlBlock` had been
  shipping **ragged indentation into every live call** — ``dedent`…` `` computes its minimum indent *after*
  interpolation and the multi-line constants it interpolates are flush-left, so nothing was ever stripped.
  Now a flush-left `string[]` + `join("\n")`; content unchanged, whitespace only; `/^ {3,}/` regression test
  added. **(2)** The "no caller ID" banner (`agents.tsx:712`) hardcoded dark-mode-only `amber-*` and was
  unreadable in light mode; now semantic `warning`/`foreground` tokens. Both were type-correct, lint-clean
  and covered by passing tests — *rendering for a human to read is a distinct verification class.*

  **NEXT on the editor:** the Tools & Guardrails tab still has no render test (the harness is a DEV page,
  not an assertion). `D1` (create-agent), `D5` (prompt versioning) and Phase IV (eval/judge) remain
  deliberately out of scope.

- **Semantic turn-detection SEAM — Five Bets Phase V (2026-07-31):** Fifth/final phase, and the Five
  Bets plan is now complete. Ships the pluggable end-of-turn (EOT) **seam + fallback discipline only —
  NOT a model vendor**, because the model is gated (zero Phase II production health data yet, pre-pilot;
  staging+prod still share `DATABASE_URL` so no isolation). New module `packages/api/src/voice/turn-detection/`:
  (1) `types.ts` `TurnEndDetector` interface `decide(input)→{done,by,reason?}`; (2) `heuristic.ts` —
  `endsMidThought`+pattern MOVED here unchanged from stream.ts, wrapped as `HeuristicTurnDetector` (default
  + always-available fallback, zero I/O); stream.ts re-exports `endsMidThought` for back-compat;
  (3) `budgeted.ts` `withLatencyBudget(primary,fallback,budgetMs)` — a slow/throwing model degrades to the
  heuristic, never adds unbounded latency to the hot path; (4) `composite.ts` — heuristic first, short-circuit
  (skip model) when it wants to hold, consult refiner ONLY when the turn looks complete; (5) `index.ts`
  `createTurnDetector(config)` + `SEMANTIC_TURN_DETECTION_FLAG` (`semantic-turn-detection`) +
  `DEFAULT_REFINER_BUDGET_MS` 300. Wiring: per-call `turnDetector` built in stream.ts start handler from the
  flag (refiner=null default → plain heuristic, byte-identical to old inline check); call site is now
  `const d = await turnDetector.decide({text}); if(!d.done){armSilenceTimer;return;}`. **Flag default OFF, no
  DB column / no migration** (org-flag path). Model wiring correctly deferred — dropping in Smart Turn/OpenAI
  Realtime/LiveKit later = pass a `refiner` + flip the flag. Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/turn-detection/turn-detection.test.ts src/voice/stream.test.ts` 24/0
  (StubModelTurnDetector mock, no live vendor, audio path untouched). **NEXT: nothing in Five Bets — model
  wiring waits on Phase II call-health data + staging isolation. No live-audio/live-server test without
  explicit go-ahead.**

- **Backchannels — Five Bets Phase IV (2026-07-31):** Fourth phase. Adds short low-latency acks
  ("Mm-hm."/"Right."/"Okay.") played sparingly while the caller is mid-utterance, covering the
  caller-is-talking silence window (pre-tool fillers only covered the agent-is-working window). Shipped:
  (1) pure `packages/api/src/voice/backchannel.ts` `shouldBackchannel(input)` → bool with all guardrails
  in one place (off unless org flag on; never while agent speaking; never on speech_final; only after
  `BACKCHANNEL_MIN_UTTERANCE_MS` 2500; rate-limited to one per `BACKCHANNEL_MIN_GAP_MS` 4000) + 10 tests;
  (2) `stream.ts` wiring — fires on Deepgram interim partials before the speech_final early-return;
  `maybePlayBackchannel` renders cached clips only (warm-cached on start via existing `warmFillerCache`);
  per-call state `callerUtteranceStartedAt` (reset on barge-in + consumed turn) + `lastBackchannelAt`;
  **NOT a turn** — never sets agentIsSpeaking / enters history / clears, so it can't corrupt
  turn-taking/barge-in/endsMidThought; (3) org flag `backchannels`, default OFF, **no DB column / no
  migration** (org-flag path like expressive-delivery). Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/backchannel.test.ts` 10/0 (41/0 across all four phase test files).
  **Synthetic-harness assert-unchanged check is N/A (text-only, no interim-STT path; backchannels never
  touch history). Real validation = controlled LIVE-AUDIO test, pending explicit go-ahead. NEXT: Phase V
  gate decision — build semantic turn-detection ONLY if Phase II call-health data shows a real
  turn-taking problem in production.**

- **Synthetic scenario expansion — Five Bets Phase III (2026-07-31):** Third phase. Extended the EXISTING
  AI-to-AI synthetic-test harness (`packages/api/src/voice/synthetic-scenarios.ts` + `synthetic-test.ts`)
  from 3 → 8 scenarios — NOT a rebuild. **Honest scope: text-only harness cannot test audio-timing
  failure modes (dead air/barge-in/mid-thought cut-off/silent STT-TTS); those stay gated on live
  telephony + Phase II health data.** Phase III locks the behavioral/prompt regressions instead. Added:
  `escalation-needed` (→`transferToHuman`), `abusive-caller-guardrail` (→`flagGuardrailEvent`, positive
  counterpart to `angry-customer`), `cod-confirmation` (→`confirmCodOrder`), `unknown-info`
  (→`lookupInfo`, hallucination guard), `multi-intent` (→`captureField`). All use existing assertion
  types (no schema change, no migration). New catalog-integrity tests in `synthetic-test.test.ts`: unique
  keys, ≥1 assertion + positive maxTurns each, and every tool assertion resolves to a real tool (closes
  the "assertion names a bogus tool → silently passes forever" trap). Verified: api+web tsc 3/3 · web
  build ✓ · oxlint 0/0 · `bun test --isolate src/voice/synthetic-test.test.ts` 10/0. **NEXT: Phase IV
  (backchannels), then Phase V gate decision from Phase II health data.**

- **Call health / silent-failure detection — Five Bets Phase II (2026-07-31):** Second phase of the
  approved Five Bets plan. `status` only says how a call ended for the carrier — it counts dead-air /
  STT-never-connected / greeting-only calls as `completed`. This derives a health verdict at call end.
  This is the phase that GENERATES the evidence Phase V (semantic turn-detection) is gated on. Shipped:
  (1) pure `packages/api/src/voice/call-health.ts` `classifyCallHealth(input)` → `{status, reasons}`,
  status `healthy|degraded|silent-failure`, judges only answered calls; named threshold constants
  (`DEAD_AIR_SILENT_MS` 8000, `DEAD_AIR_DEGRADED_MS` 3000, `LLM_TTFT_DEGRADED_MS` 2500,
  `STT_CONNECT_DEGRADED_MS` 2000) + 14 unit tests; (2) additive nullable `calls.healthStatus` (text) +
  `calls.healthReasons` (jsonb) + index `calls_health_status_idx` + **offline** migration
  `drizzle/0046_colorful_robbie_robertson.sql` — **NOT applied; user runs `db:migrate` (shared DB);
  Call Health view empty until then**; (3) `stream.ts` `finalizeCall` classifies from in-memory signals
  (added `transcriptCount` counter + local `sttReconnectCount` mirror) and folds the verdict into the
  SAME finalize `update` (atomic, no extra write); (4) admin `GET /api/voice/compliance/call-health`
  (`status`/`orgId` filters, only computed verdicts, `{calls, byStatus, byReason, total}`); (5) "Call
  Health" card in `compliance.tsx` (filter chips + per-call reason lists + CSV export). Verified: api+web
  tsc 3/3 · web build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/call-health.test.ts` 14/0.
  **Migration 0046 pending user apply. NEXT: Phase III synthetic scenario expansion (await go-ahead).**

- **Guardrail event log — Five Bets Phase I (2026-07-31):** First phase of the approved Five Bets plan
  (`docs/product-strategy/five-bets-build-plan-2026-07-31.md`). Approved sequencing (inverted from
  research): **I** guardrail-events table (this) → **II** silent-failure/call-health detection → **III**
  synthetic scenario expansion → **IV** backchannels → **V** semantic turn-detection (last, gated on
  Phase II data showing a real turn-taking problem). Shipped: (1) `guardrail_events` table in `schema.ts`
  + **offline** migration `drizzle/0045_sour_matthew_murdock.sql` — **NOT applied; user runs `db:migrate`
  (shared DB); panel empty until then**; (2) pure `packages/api/src/voice/guardrail-events.ts`
  `deriveGuardrailEventFields(name, input)` → `{category,source,detail}` | null (category enum
  topic-boundary/unauthorized-promise/prompt-injection/abuse/unknown; source agent-self-report |
  heuristic-detector) + 7 unit tests; (3) `stream.ts` `logToolCall` fire-and-forget insert after the
  `toolCalls` insert (both guardrail signals already funnel through this one choke point; best-effort,
  swallows DB errors, never blocks call — ADR-062); (4) admin `GET /api/voice/compliance/guardrail-events`
  (`orgId` filter, `{events, byOrgCategory, bySource, total}`); (5) "Guardrail Event Log" card in
  `compliance.tsx` (per-event list + `bySource` chips + CSV export). Existing `/compliance/overview`
  tool_calls-scan counts left untouched (cover pre-migration calls). Verified: api+web tsc 3/3 · web
  build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/guardrail-events.test.ts` 7/0.
  **Migration 0045 pending user apply. NEXT: Phase II call-health detection (await go-ahead).**

- **Canvas product telemetry — first-party event pipe (2026-07-31):** Closed the highest-value gap
  flagged below — the canvas/Customize flow was unmeasured. Built a **first-party** product-usage event
  pipe (deliberately NOT PostHog/Amplitude: zero vendor cost, data stays in our Postgres, no PII to a
  processor, pre-pilot volume is tiny). Three pieces: (1) `product_events` table in `schema.ts` +
  **offline** migration `drizzle/0044_nostalgic_lilith.sql` — **NOT applied; user runs `db:migrate`
  (shared DB)**; (2) `packages/api/src/app/events-ingest.ts` (pure `parseEventBatch` — name regex,
  4KB props cap, batch cap 50, epoch sanity; best-effort `recordEvents` that swallows DB errors) +
  `POST /api/app/events` after `requireUserOrg` (orgId/userId from session, always 2xx, 429 on flood,
  limiter `APP_EVENTS_RATE_LIMIT` 120/60s); (3) `packages/web/src/web/lib/analytics.ts` — typed
  `track()` that **never throws/blocks**, canonical `AppEventName` union (14 names; server validates
  shape only so new events are client-only), sessionId + batched flush + keepalive on hide. Deleted the
  dead `window.stonks` shim (`types/analytics.d.ts`). Wired `workflows.tsx` end-to-end: activation funnel
  (`workflow_list_viewed` → `workflow_customize_started {source: template|blank|ai_draft|reopen}` →
  save `attempted`/`blocked`/`succeeded` with `activated:true` + `msSinceStart` → list-toggle
  `activated`/`paused`) + canvas-usage (`node_added {via}`, `node_deleted`, `edge_connected`,
  `node_config_opened`) + AI-draft (`requested`/`succeeded`/`failed`). Activation not double-counted
  (save carries `activated:true`; toggle events reserved for list). Verified: api+web tsc 0 · web build
  ✓ · root oxlint 0/0 · `events-ingest.test.ts` 9/0 · `bun test --isolate src/app/` 45/0.
  **No funnel UI yet** (the first-party trade-off) — query `product_events` via SQL / small admin view
  later. Admin `workflow-editor.tsx` intentionally not instrumented (merchant flow only).
  **Migration 0044 pending user apply.** Pre-existing `src/app` test-isolation issue (below) still open.

- **Workflow graph validation (P1) + Sentry loop closed (2026-07-30):** Shipped a shared,
  authoring-time graph validator and proved the monitoring loop end-to-end.
  **Sentry:** ran a one-off smoke test through the real `initSentry`/`captureError` +
  `Sentry.flush(5000)` → returned `true` (event delivered), env-tagged `sentry-smoketest`. Loop is
  proven working; `SENTRY_DSN` set on Railway prod+staging. Smoke-test script deleted, not committed.
  **P1 validation:** new pure module `packages/api/src/voice/workflows/graph-validation.ts`
  (`validateWorkflowGraph(graph)` → `{ issues, errors, blockers, warnings }` + `hasStructuralErrors`,
  `canActivate`; no I/O). Severity taxonomy maps to real `graph-engine.ts` runtime behavior —
  **error** (run fails/ambiguous → always block save), **blocker** (runs wrong/nothing → block admin
  save + merchant *activation*, allow draft), **warning** (engine tolerates → never blocks, surfaced).
  This is the authoring-time **belt**; `validateLockedNodesEnforced` stays the compliance **suspenders**
  and `scheduler.ts` stays the runtime enforcement — neither replaced. Wired: admin `validateGraph`
  delegates to it; merchant `PUT /workflow-configs/:templateKey` (errors→400 always, blockers→400 when
  `enabled:true`, warnings echoed in 200 body); `ai-draft` rejects drafts with structural errors only
  (blockers expected — merchant fills them in). Frontend `workflows.tsx` surfaces an amber "Saved with
  N suggestions" note. 14 new tests (`graph-validation.test.ts`). Verified: `packages/api` tsc 0 ·
  `packages/web` tsc 0 · web build ✓ · root `oxlint` 0/0 · `bun test src/voice/workflows` 110 pass/0.
  **Known pre-existing (NOT this work):** `bun test src/app` has 1 failing test
  (`supabase-auth.test.ts`, `getOrgLead` export + `db.update` mock leaking across files when the whole
  `src/app` dir runs in one invocation); reproduces on a clean tree, passes in isolation — flagged for
  a separate test-isolation fix. **Still open:** P2 template gallery at entry; **no usage analytics on
  the canvas/Customize flow** (still the highest-value gap — instrument before further tuning).

- **Workflow builder P0 UX fixes — persona dropdown + AI-draft front door (2026-07-30):** After a cold
  UX audit of the merchant workflow builder (`audit/2026-07-30-audit-08-workflow-canvas-ux.md`) +
  competitor matrix. **Decision: keep the canvas** — it's *orchestration* (the Shopify-Flow pattern
  merchants know), not conversation-flow; the fix is to stop making raw wiring the front door.
  Shipped two P0s: (1) call-node `persona` is now a **dropdown** of the org's agents instead of raw
  text (a call node could otherwise point at a non-existent agent — persona = a resolved templateKey).
  `NodeConfigPanel` took an optional `personaOptions` prop and stays presentational, so the admin
  template editor keeps the raw input (different auth); merchant canvas feeds it via new
  `useAgentPersonaOptions` (`GET /api/app/agent-configs`). (2) The AI-draft "describe your flow" bar,
  previously buried inside the canvas, is now the **primary path on the Standard View entry** →
  generate → land in canvas to edit/save. Files: `components/canvas/NodeConfigPanel.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc 0 · build ✓ · root `oxlint` 0/0.
  **Still open:** P1 graph validation, P2 template gallery, and — flagged highest-value — **no usage
  analytics exist on this flow**, so all of the above is reasoned from code+competitors, not observed
  sessions; instrument before tuning. `SENTRY_DSN` is set on Railway (prod+staging) but not yet proven
  end-to-end. Whether SMBs should ever see a node-graph canvas at all: deferred (canvas kept for now).

- **Workflows Standard View — affordance/legibility fixes (2026-07-30):** Follow-up to a UX audit —
  a tester got lost on the default workflow view because the read-only React Flow graph looks editable
  but only `wait/call/sms` nodes respond to a click, with no signal which. Fixed with pure
  affordance/legibility changes (no architecture change; canvas editor untouched): editable-node cue
  (hover ring + pencil + pointer cursor via a new `editable` flag on `WorkflowNode`), an orientation
  strip + legend above the graph, "Save changes" now only renders when there are unsaved edits (was a
  looks-broken disabled button on load), and the "No workflows" empty state gained a "Connect your
  store" CTA to `/app/integrations` (was a dead end). Files: `components/canvas/WorkflowNode.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc clean · build clean · `oxlint` 0/0.
  See `changelog/2026-07.md`. **Still open (unchanged):** set `SENTRY_DSN` on Railway; the deeper
  question of whether SMBs should ever see a node-graph canvas at all (deferred, not this session).

- **App UI/UX Restructuring & Integrations Alignment (2026-07-20):** Resolved UI defects across `/app` routes.
  **Toaster Z-Index Elevation**: Elevated Sonner `Toaster` z-index to `99999` in `sonner.tsx` and `styles.css`
  so notifications float over all modal dialogs, drawers, sticky headers, and backdrop overlays.
  **Integrations Page Redesign**: Removed `bg-background` root class overrides in `integrations.tsx` (preventing
  nested double-background box artifacts) and replaced full-screen blur overlays (`fixed inset-0 z-50`) with an
  inline card-level status banner. **Route Fallbacks**: Upgraded `PageFallback` in `app.tsx` from a bare spinner
  to a structured page skeleton (`page-enter space-y-6`). Verified: `typecheck` clean · `test` 16 pass / 0 fail · `build` clean. Pushed to `origin/main`.

- **Native, person-centric leads/records layer shipped (2026-07-19, Phases 1–3):** built the *owned*
  data-of-record layer before bolting on external CRMs. New tables (`leads` deduped by
  `(orgId, phone)`, `leadIntakeSchemas`, `leadApiKeys`; `calls.leadId` plain indexed int, no FK;
  migration `0040_mushy_arclight.sql`). **Phase 1 (owned core):** captured fields promoted
  `capturedState → leads.fields` at `finalizeCall`; insurance `Leads` page (list/search, detail +
  call history, pipeline status, assign advisor, call-now, Excel export, manual add/edit).
  **Phase 2 (edges & config):** `POST /api/leads/ingest` (per-org `wlk_` key auth, schema-validated,
  regulated keys rejected, idempotent upsert; `triggerWorkflow` accepted-but-not-wired until it
  respects DNC/TCPA dial-gates) + per-org/per-agent intake-schema editor. **Phase 3 (reach):**
  public hosted form `/f/:orgId` (**`orgId` is the non-secret write-only form token** — honeypot +
  per-(ip,org) rate limit, no migration) + on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL,
  leads stays source of truth). Scoping decisions in **ADR-061**; plan in
  `product-strategy/native-leads-layer-plan-2026-07-19.md`. Verified: `typecheck` clean · `test`
  **621 pass / 0 fail** · `lint` 0/0 · `build` clean.
- **Integrations strategy set (2026-07-19):** Pipedream on the *inbound* edge (any CRM/form → our
  ingest API), native adapters for *outbound* (CRM mirror). `product-strategy/integrations-strategy-
  and-roadmap-2026-07-19.md`; recipe in `integrations/pipedream-inbound-recipe.md`. **Pipedrive
  native adapter** flagged as the next likely inbound native adapter.
- **Insurance vertical filled out (2026-07-19):** config-driven en/hi/hinglish language variants for
  insurance agents 04–08, plus a new **Final Expense Qualifier + Warm-Transfer** agent (persona 09,
  scoped US/English-only). All 10 insurance agent prompts now live in `docs/agent-prompts/`.
- **Language support: closed/scoped (ADR-060, 2026-07-19)** — see the section below.
- **Workflow Canvas v4 Phase 3 — SHIPPED (2026-07-19), not open.** Flow preview via web call is
  built and merged (`voice/workflows/preview-walker.ts`, `components/workflow-preview/
  FlowPreviewPanel.tsx`, commits `a9dca16`/`91b13ac`; changelog `b491f15`). The whole v4 plan
  (Phases 1/2/3) is done — do not carry this forward as an open item again.
- **Still open from 2026-07-18 (carried forward):** adopt **Supabase Realtime** for the dashboard
  (decided `ADR-058`, not built — currently polls `refetchInterval` every 4–5s); **set `SENTRY_DSN`
  on Railway** (Sentry wired, no-op until the env var is set). Everything else from the 2026-07-18
  session (insurance KPI-mislabel fix, feedback agent live, VoiceOrb rebuild, infra review, pricing
  lock `ADR-057`, docs→brain restructure) shipped — see `progress.md` "Closed recently" and
  `changelog/2026-07.md`.

## Language support: closed, scoped correctly (ADR-060, 2026-07-19)

**B2 — multilingual understanding, not mid-call switching.** The Hindi/Hinglish STT/TTS foundation is
solid and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), and Indic
calls now smart-default to Sarvam automatically (ADR-060, `../voice-quality/language-support.md`).
Mid-call *spoken-language switching* is REJECTED — not an open gap — because flipping the TTS voice
mid-call breaks voice identity, adds latency, and destabilizes the call (one fixed spoken language per
call; STT code-switching understanding is separate and stays). The differentiator is native Hinglish
+ multilingual understanding, not a switching gimmick. Only open B2 item: B2.5 (localized system
messages), minor polish. See `WEEBER-PLAN.md` Phase B and ADR-060.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

**Road ahead is now tiered in `WEEBER-PLAN.md` → "Road ahead — prioritized (2026-07-19)". Short version:**

- **Tier 1 (highest leverage):** **C4b — ingest-triggered call activation.** Wire the
  accepted-but-not-wired `triggerWorkflow` on `/api/leads/ingest` → agent router → outbound call,
  routed through the existing DNC/TCPA/quiet-hours dial-gates (reuse `scheduler.ts` /
  `place-outbound-call.ts`). This is the "lead lands → agent picks → call fires" loop; the leads
  layer (C4) is shipped up to the point where the call would fire.
- **Tier 2 (multi-channel reach):** C5 — WhatsApp node/tool/action mirroring the SMS 3-surface
  pattern; expose the transactional email path (`app/email.ts`) as a flow node; cross-channel
  fallback chains (Wait + delivery/read-status branch).
- **Tier 3 (integrations/templates):** C6 — Pipedrive native inbound adapter + Pipedream
  connector layer; activate per-org `wlk_` keys for a first external source; vertical flow
  templates (clinic/hotel/restaurant) once those verticals are built.
- **Tier 4 (carried forward):** Supabase Realtime dashboard (`ADR-058`, decided not built);
  `SENTRY_DSN` on Railway; A1b VAD/endpointing audit; B2.5 localized system messages.
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).
- **C4b entry-condition branching** — config-driven vs. visual-canvas-from-day-one for the
  ingest→call activation router is still the open product decision (CLAUDE.md gate #4). Ask before
  building the routing UI.

_Last updated by: ADR-114 (per-agent transfer destination, and collapsing the two independent reads of the transfer number into one), 2026-08-14._
