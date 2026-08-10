---
doc: audit-15
status: findings — no code changed
date: 2026-08-10
scope: market/geo differentiation, language layer, prompt architecture, custom-agent surface
grounded-against: HEAD 8498e58 (`main`) + production DB (Supabase pooled) + primary market sources
---

# Audit 15 — the market is a column nobody reads

Audits 13 and 14 asked whether a call is fast and whether the agent knows what it is saying. This one
asks the question one level up: **the code says "India-first", the deployment is entirely US, and the
two are wired together by nothing.** `agent-frame.ts:53` states it outright in a comment —
"India-first list since that's the primary market" — and `pricing-lock-2026-07-18.md` decision #3
locked "India and Global are separate plans, not a currency toggle." Neither statement has a field,
a code path, or a production row behind it.

Everything below is either read out of the source at `8498e58`, queried out of the production
database, or cited to a primary external source with the citation attached. Where a number is
vendor-published or paper-published rather than measured on Weeber's own audio, it says so. Nothing
here was benchmarked locally — there are no provider keys in this environment (see §8).

---

## 0. The headline

Four findings decide the next quarter, and three of them are the same defect wearing different
clothes: **market is treated as a property of the phone number being dialled, not a property of the
business.**

| # | Finding | Sev |
|---|---|---|
| F1 | The India insurance vertical is legally undeliverable as built, and our own gate correctly blocks it. TRAI's 16 Dec 2025 Direction bars IRDAI-regulated entities from *any* service/transactional call on a non-1600-series number after 15 Feb 2026 — a deadline that has passed. All four production numbers are US Twilio DIDs with `number_series` NULL. | **P0** |
| F2 | `orgs.country_code` / `currency` / `timezone` are **write-only**. They are accepted by `PATCH /api/app/settings`, echoed by `GET /me`, and read by zero code in `packages/api/src/voice/`. Jurisdiction is inferred at dial time from the *recipient's* phone prefix instead. 3 of 4 production orgs have all three NULL. | **P0** |
| F3 | The entire Indic investment is unreached in production. `language` is NULL on **14 of 17** `org_agent_configs`; `buildLanguageInstructionBlock` returns `""` for null/`en`; Sarvam ran on **0 of 25** production calls. The ₹1.2/min Sarvam COGS that the locked India margin's *good* case depends on has never occurred. | **P1** |
| F4 | The production STT default (Deepgram Nova-3) is rated Tier III — "inadequate" — on Indian telephonic speech by the largest published benchmark of it, with most Indic languages unsupported outright. The Tier I model on that benchmark (Sarvam) is fully wired, program-credited, and idle. | **P1** |
| F5 | `language` is a **free-text input** on a field that silently switches STT provider, TTS provider, voice identity, and disclosure language. `"hi-IN"` and `"Hindi"` both fail `prefersSarvam()` and fall back to the English-first stack with no warning. | **P1** |
| F6 | Localised recording disclosures exist for **3 of 12** recommended languages (`en`, `hi`, `hinglish`). A Tamil agent speaks a Sarvam Tamil voice and an English legal disclosure. The `hi`/`hinglish` lines are marked in-code as drafts pending human review — and are the live path. | **P1** |
| F7 | "Custom agents" is an **admin-only** authoring surface. 9 templates, all `visibility=public`, `owner_org_id` NULL, zero private. `persona_prompt` is NULL/empty on **17 of 17** configs — no customer has ever customised a prompt. That is a services motion priced as self-serve SaaS. | **P1** |
| F8 | `calls` has no `template_key`, no `agent_config_id`, no `language`. A call cannot be attributed to an agent, a template, or a language — so F3, F4, F6 and F7 are unanswerable from data, permanently, by design. | **P1** |
| F9 | The US-only, English-only, 19,480-character final-expense template is enabled on **2 of 3** insurance orgs. Market scope for a template lives only in prose inside `default_persona_prompt`; no `region`/`market` column exists on `agent_templates` or `org_agent_configs`. | P2 |

---

## 1. F1 (P0) — India insurance cannot legally be delivered, and we block it ourselves

### The rule (primary source, fetched)

**TRAI Direction dated 16 December 2025, F. No. G-6/(8)/2025-QoS-Part(I) (E-18071)**, retrieved from
`https://www.trai.gov.in/sites/default/files/2025-12/Direction_16122025.pdf`. Operative content:

- 1600-series adoption by all IRDAI-regulated entities was to be **completed by 15 February 2026**.
- Failure attracts action "as per regulatory provisions applicable to **unregistered telemarketers**"
  under TCCCPR 2018 reg. 3 — i.e. suspension/disconnection of telecom resources.
- Clause (iii), verbatim: *"entities regulated by IRDAI are not permitted to initiate any service or
  transactional voice calls, even with the explicit or inferred consent of customers, from numbers
  other than those allocated under the 1600-series, after the 15th February 2026."*
- 15-day status reporting obligation.

Note the scope of clause (iii): **consent does not cure it.** This is not a promotional-calling rule
that a consent record satisfies. It is a number-origination rule. Our consent machinery — which is
genuinely good — is irrelevant to it.

The repo already knew this. `docs/agent-prompts/00-insurance-regulatory-reference.md:21` describes the
mandate accurately and flags it as a real platform gap; the gap was subsequently built.

### What the code does

`packages/api/src/voice/compliance/insurance-gates.ts:74` requires an **active `org_phone_numbers`
row with `number_series = "1600"`** for any insurance org dialling India. It is unconditional — no
feature flag, no vertical exemption beyond `orgs.vertical === "insurance"`. It is wired into both
dial paths: `workflows/scheduler.ts:81` (`reason: "insurance_number_series"`) and
`voice/routes.ts:289` (403).

The general non-insurance counterpart, `compliance/number-series-gate.ts`, requires a 140/160-series
number for other verticals — but it is behind `INDIA_NUMBER_SERIES_FLAG`, **off by default**, with the
reason documented in the file header: a live Shopify org dials India numbers today from an
unregistered Twilio number, and turning the gate on unconditionally would have broken it.

### What production actually holds

```
id | org_id                                   | phone_number  | number_series | status   | provider
 4 | org_58c7d5cc-…  (krisn, insurance)       | +17126257861  |  (null)       | active   | twilio
 5 | org_68497dd7-…  (rishipawar8999, ins.)   | +17754554413  |  (null)       | active   | twilio
 6 | org_58c7d5cc-…                            | +17744745274  |  (null)       | released | twilio
 7 | org_a4ddb581-…  (presistentads, ins.)    | +18573706834  |  (null)       | active   | twilio
```

Four numbers. All `+1`. All Twilio. `number_series` NULL on every row. Three of the four production
orgs are `vertical = insurance`, and one of them (`org_68497dd7`) is the only org with
`country_code = IN` / `timezone = Asia/Kolkata` set at all.

### The conclusion

For every insurance org in production, an outbound call to any `+91` number is blocked at dial time
and always will be, because:

1. The gate demands a 1600-series number.
2. Twilio does not allocate 1600-series numbers. That series is allocated to IRDAI-regulated entities
   through Indian TSPs and coordinated by Indian CPaaS vendors — Exotel, Ozonetel, FreJun, C-Zentrix
   (vendor-published onboarding claims; Exotel advertises 1600-series plus DLT registration in under
   48 hours — vendor claim, not verified by us).
3. `project-brief.md` lists Exotel as supported BYO India telephony. **No production org uses it.**
   Every row above says `twilio`.

The gate is correct and I would not weaken it. The finding is not "the gate is wrong" — it is that
**the gate is the only part of the India insurance story that exists.** The compliance check for a
capability we do not have is a very expensive way to discover we do not have it.

**Unverified, do not repeat:** a vendor blog claims these rules carry ₹10 lakh penalties. No primary
source supports that. The verified sanction is unregistered-telemarketer treatment under TCCCPR 2018,
i.e. telecom-resource suspension.

---

## 2. F2 (P0) — the market axis exists in the schema, the UI, and nowhere else

### Three columns, zero readers

`orgs` carries `country_code`, `currency`, `timezone`. Grep across the whole API for their consumers:

- `packages/api/src/app/routes.ts:257-258`, `:369-370` — echoed in `GET /me`.
- `packages/api/src/app/routes.ts:311` — accepted in `PATCH /api/app/settings`.
- `packages/api/src/voice/org-queries.ts` — selected into a result object.
- `packages/web/src/web/pages/app/settings.tsx:64` — the UI defaults `countryCode` to `"IN"`.

**Zero reads anywhere under `packages/api/src/voice/`.** The only hits in that directory are the
unrelated `listAvailableNumbers(orgId, countryCode, …)` parameter in `twilio-provisioning.ts:198` and
`admin-routes.ts:192`, which is a Twilio search filter, not the org's market.

`orgs.currency` has the same shape. The one place a currency reaches a prompt is
`workflows/variables.ts`, and that reads `context.currency` from the *workflow payload* (Shopify's
cart currency), not the org's. So an org that declares itself Indian does not get rupees in its
agent's mouth; a Shopify webhook does.

### What decides jurisdiction instead

`packages/weeber-compliance/src/calling-window.ts:30` → `isIndianNumber(e164)` → if `+91`, apply
`packs/india.ts` (09:00–21:00 IST, single `Asia/Kolkata` timezone); otherwise apply `packs/us.ts`
(area-code → state → state-specific window). The limitation is acknowledged in that file's own
comment.

For calling windows specifically this is defensible — the callee's local time is what the window is
about. For everything else it is wrong, and it is why F9 happens:

| Decision | Should depend on | Actually depends on |
|---|---|---|
| Calling window | callee locale | callee prefix — **correct** |
| Which compliance pack's consent/licensing rules apply | the *business's* regulator | callee prefix |
| Which templates an org may enable | the business's market | nothing — all 9 are public to all |
| Currency spoken in a quote | the business's market | Shopify webhook payload, or nothing |
| Default language / provider | the business's market | per-config `language`, NULL 14/17 times |
| Which pricing plan the org is on | the business's market | not implemented at all |

### Why this is a P0 and not a nit

`pricing-lock-2026-07-18.md` decision #3 is explicit: *"Geo-differentiated pricing — India and Global
are separate plans, not a currency toggle,"* with two distinct pricing pages, two tier tables
(₹2,499/₹12,999 vs $79/$499), and different compliance framing per market. That decision was locked
three weeks ago and **there is no field in the product to hang it on.** Billing cannot select a plan
family, the dashboard cannot show the right currency, and no code path can behave differently for an
Indian customer than an American one.

Three of four orgs have `country_code` NULL. Even if something read the column, it would read nothing.

---

## 3. F3 (P1) — the Indic layer is fully built and has never run

### The chain, verified end to end

1. `RECOMMENDED_LANGUAGES` (`agent-frame.ts:57-70`) — 12 entries: `en, hi, mr, ta, te, kn, ml, bn, gu,
   pa, hinglish, multi`. Comment at `:53`: *"India-first list since that's the primary market."*
2. `SARVAM_PREFERRED_LANGUAGES` (`:86`) + `prefersSarvam()` (`:88`) route the 10 Indic/Hinglish codes
   to Sarvam when no explicit provider is set — guarded by `SARVAM_API_KEY` (`stt/index.ts:40`,
   `tts/index.ts:37`). ADR-060.
3. `buildLanguageInstructionBlock()` (`agent.ts:293`) returns **`""`** when `!language || language === "en"`.
   Separate branches exist for `multi` (`:295`) and `hinglish` (`:311`); otherwise it emits *"Conduct
   this entire call in ${label}"* (`:322`) plus an explicit instruction not to switch even if the
   caller does (`:303-317`). Emitted as prompt segment `"language"` (`agent.ts:363`, `:426`).
4. Provider normalisation: `toSarvamLanguageCode()` maps `hinglish → hi-IN`, else `${language}-IN`
   (`stt/sarvam.ts:116`, `tts/sarvam.ts:17`). `toDeepgramNova3Language()` (`stt/deepgram.ts:44`)
   **rejects `hinglish` and `ml` outright**, warns, and falls back to multi-language mode.
5. Audited canned Hindi/Hinglish greetings exist for 5 insurance templates
   (`voice/insurance-greetings.ts`); any other language returns `undefined` and falls through to an
   LLM-generated greeting.

That is a well-built, well-documented, well-tested subsystem. Now the production side:

```
org_agent_configs: 17 rows
  language:        NULL on 14; set on 3 (one 'en', one 'hi', one other)
  persona_prompt:  NULL/empty on 17
calls 16–25:       stt_provider_used = deepgram  (10/10)
                   tts_provider_used = cartesia  (9/10; call 21 = elevenlabs, failover_count 2, degraded)
                   llm_provider_used = gateway   (10/10)
Sarvam:            0 calls, all-time
```

So: `language` NULL → `buildLanguageInstructionBlock` returns `""` → **no language instruction is in
the prompt at all** → the model follows the (English) persona text → `prefersSarvam(null)` is false →
Deepgram + Cartesia. Every branch of the Indic work is downstream of a field that is empty in 82% of
production configs.

### The unit-economics consequence

`pricing-lock-2026-07-18.md` §"Final quick sanity check" prices India Starter (₹2,499 / 357 min) with
a margin range of **43% (Deepgram+Cartesia, ~₹4/min) to 83% (Sarvam, ~₹1.2/min)**, and describes
Sarvam as *"the actual India-language default."*

It is not the actual default. It is the *conditional* default, conditional on a field that is unset.
The observed production stack is the ₹4/min one. **43% is not the floor of that range — it is the
current number.** The good case in the locked model has occurred zero times.

This also matters for the Sarvam Startup Program credits: they subsidise a provider we do not call.

---

## 4. F4 (P1) — our default STT is bottom-tier for the market we call primary

**Source: arXiv 2604.19151v2, "Voice of India."** Closed-source benchmark: 306,230 utterances /
536.1 hours / 36,691 speakers / 15 Indian languages / 139 regional clusters, **unscripted telephonic
speech** (i.e. our actual channel, not read-aloud corpora). Metric is OIWER, multi-reference, tolerant
of spelling variation. **Paper-cited, not measured by us.**

Word error rate, selected — lower is better; `—` = language not supported by that system:

| | as | bn | bho | gu | hi | hne | ka | mai | ml | mr | or | pa | ta | te | ur |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Sarvam Audio** (Tier I) | 12.7 | **6.1** | 20.9 | 12.8 | **5.0** | 17.6 | 16.3 | 24.8 | 18.9 | 9.4 | 14.0 | 11.2 | 14.2 | 18.2 | **7.0** |
| **Deepgram Nova-3** (Tier III) | — | 28.9 | 45.8 | — | 13.0 | 42.4 | 53.7 | — | — | 43.7 | — | — | **67.8** | 43.1 | — |
| ElevenLabs Scribe v2 | — | — | — | — | 7.7 | — | — | — | 23.0 | — | — | — | 20.4 | — | 25.5 |

Findings that matter to us:

- **Sarvam Audio is Tier I — lowest WER in 13 of 15 languages.**
- **Deepgram Nova-3 is Tier III, the paper's "inadequate systems" band** (ranks 9–16, WER > 35%), with
  coverage gaps in 7 of 15 languages. The paper separately cites Nova-3 Odia at **89.8**. Tamil at
  **67.8** means roughly two words in three are wrong.
- **No system is consistently under WER 20 across all 15 languages** — the paper's own stated
  practical-usability threshold. Even Sarvam exceeds it on Bhojpuri (20.9) and Maithili (24.8).
- Systematic 19–21% male-speaker penalty. District-level WER ranges ~4% (Nainital) to 44%
  (Mannarakkat). Out-of-region migrants degrade to 55–65%. Models that look strong on FLEURS degrade
  substantially here — read-corpus scores do not transfer to telephony.
- AssemblyAI Universal exceeds WER 100 on several languages (transcription failure). GPT-4o-mini
  Transcribe hits 295.9 on Gujarati. Gemini 3 Pro is competitive on Hindi (6.0) and best on dialectal
  Bhojpuri/Chhattisgarhi.

Three consequences:

1. The provider in our default path is the worst-rated of the credible options on the channel and the
   market we say is primary. The best-rated one is wired, credited, and idle (F3).
2. Audit 14's transcript-correctness findings were all on **English** calls. If an Indic pilot starts
   on the current default, add a 13–68% WER floor on top of those. No amount of prompt work survives
   an STT layer that mis-hears two-thirds of the words.
3. **Any marketing claim of "10+ Indian languages" is not defensible at usable quality.** Defensible
   today, on this evidence and with Sarvam actually selected: `hi`, `bn`, `pa`, `ur`, `mr`, `or`, plus
   `en`. Tamil/Telugu/Malayalam/Maithili/Bhojpuri are above the usability threshold on **every**
   system in the benchmark. Scope the claim to the languages, and say "with human escalation" for
   the rest.

**Caveat I will not paper over:** these are one paper's numbers on one closed benchmark, and Sarvam is
both the top scorer and an Indian lab with an interest in that result. The direction is consistent
with ADR-060's own reasoning and with Deepgram's published language list, but the *magnitudes* should
be reproduced on our own recorded audio before they go in a deck. That requires keys (§8).

---

## 5. F5–F6 (P1) — the language field and the disclosure that does not follow it

### F5 — a free-text input that switches providers

`packages/web/src/web/pages/app/agents.tsx:361`:

```tsx
<input id={`lang-${row.templateKey}`} value={form.language} onChange={(e) => set("language", e.target.value)}
       placeholder="en, hi, mr…" list={`langs-${row.templateKey}`} className={fieldCls} />
```

An `<input>` with a `datalist`, next to two `<select>`s for STT and TTS provider. `language-support.md`
defends this deliberately — "open free text… the curated list is a starting point, not a fence" — and
as a *schema* argument that is right. As a *UI* argument it is wrong, because:

- `prefersSarvam()` (`agent-frame.ts:88`) is an exact lowercase membership test. `"hi"` → Sarvam.
  **`"hi-IN"` → not Sarvam. `"Hindi"` → not Sarvam. `"hin"` → not Sarvam.** All three silently take
  the English-first stack, and `buildLanguageInstructionBlock` cheerfully instructs the model to
  "Conduct this entire call in hi-IN".
- Nothing validates against `RECOMMENDED_LANGUAGES` on save.
- The field also keys the disclosure lookup (§F6) and the Sarvam `${language}-IN` code construction,
  so a typo degrades recognition quality, voice identity, and the legal line at once.

The fix is not to remove free text — it is a `<select>` of the 12 curated codes plus an explicit
"other (advanced)" escape that warns that provider smart-defaults will not apply. Keep the escape
hatch; stop making it the default interaction.

### F6 — disclosure coverage is 3 of 12

`packages/weeber-compliance/src/consent.ts:58`, `DISCLOSURE_TEXT_BY_LANGUAGE` — **`en`, `hi`,
`hinglish`. That is all.** `resolveDisclosure` (`:91`) normalises the tag (`hi-IN` → `hi`) and falls
back to the English default for anything unmatched.

**Correction to an earlier working note:** an earlier note in this lane recorded that `hinglish` was
missing a disclosure key. That was wrong — the romanised Hinglish line exists at `:61`, with a
correct rationale in the comment (a Hinglish agent's TTS speaks Hindi via `hinglish → hi-IN`, so the
disclosure must match the romanised surface form). The real gap is the other eight languages.

So a Marathi, Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati or Punjabi agent — every one of
which routes to a Sarvam voice in that language — opens the call by speaking the **English** legal
disclosure through that voice. It is arguably worse than no localisation: it is the one sentence on
the call with legal weight, delivered in a language the callee may not have been addressed in.

Second, smaller point, in the same file's comment: *"Both non-English lines are drafts pending human
review before they're spoken on a real call."* They are the live path. Nothing gates them.

`packages/weeber-compliance` is a **STOP-AND-ASK** package per `project-brief.md`. Flagged, not
touched. The decision to make is binary and belongs to you: either extend coverage to the remaining
eight, or narrow `RECOMMENDED_LANGUAGES` to what is compliance-complete. Shipping a language picker
that outruns the disclosure table is the one option that should be off the table.

---

## 6. F7–F9 — customisation, attribution, and the US script inside India orgs

### F7 — "custom agents" is a services motion priced as SaaS

`agentTemplates` INSERT/UPDATE live only in `packages/api/src/voice/admin-routes.ts:358`, `:412`,
`:453` (the last flips a template to `visibility=private` + `ownerOrgId`, per ADR-086/091). There is
**no merchant-facing create path.** A customer can toggle a template on, set language/providers/tone,
and write a `persona_prompt` — nothing more.

Production:

- `agent_templates`: 9 rows, **all `visibility=public`, all `owner_org_id` NULL**, all active.
  Insurance ×6 (`appointment-setter` 11,197 chars, `feedback-nps` 10,382, `final-expense-qualifier`
  19,480, `lead-followup` 10,337, `policy-renewal` 10,827, `post-sale-welcome` 12,425), Shopify ×3
  (`cart-recovery` 8,386, `cod-confirmation` 7,933, `feedback` 6,579). **Zero private/bespoke
  templates exist.**
- `org_agent_configs.persona_prompt`: **NULL or empty on 17 of 17.** No customer has ever written a
  prompt.

The private-template machinery from ADR-086/091 is correct and has zero users. And that is a
strategy question, not a bug: if agent authoring is something *we* do per account, Weeber is a
managed service and should be sold and staffed as one. The locked ₹2,499 / $79 self-serve tiers
assume the opposite. Pick one; they cannot both be true.

### F8 — calls are not attributable

`\d calls` — **no `template_key`, no `agent_config_id`, no `language`.** It does carry
`stt_provider_used`, `tts_provider_used`, `llm_provider_used`, `health_status`,
`provider_failover_count`, `estimated_cost_usd_cents`, `sentiment`, `intent`, `disposition`.

So we can answer "which vendor served this call" but not "which agent, which template, which
language." Which means every question raised in this document — does Sarvam actually reduce WER on our
audio, do Hindi calls convert differently, which template is worth the 19k characters — is
unanswerable from production data, now and retroactively. Three additive columns, one migration,
zero risk under the additive-only invariant. This is the cheapest finding in the document and it
gates the value of every other one.

### F9 (P2) — the US script is live inside India-declared orgs

`docs/agent-prompts/09-insurance-final-expense-qualifier-agent.md` states its scope explicitly: *"US,
English-only… unlike the 04–08 insurance agents, which are bilingual EN/HI for the India+US launch,"*
and that it exists because a US final-expense agency wanted its existing closer script.

`insurance-final-expense-qualifier` — 19,480 characters, US-only, English-only — is **enabled on 2 of
3 insurance orgs** (config 24 on `krisn`, config 36 on `presistentads` with explicit
`deepgram`/`cartesia`/`gateway`). That is the direct explanation for the USD burial-cost figures
observed in calls 24 and 25.

There is no mechanism that could prevent this: `agent_templates` and `org_agent_configs` have **no
`region` / `market` / `jurisdiction` column** (verified via `\d`). Template market scope exists only
as prose inside `default_persona_prompt` and in `docs/agent-prompts/*.md`, which no runtime reads.
Combined with F2, the market axis is absent at both ends — the org does not declare one in a way code
can read, and the template does not declare one at all.

---

## 7. What we are wrong about

Not defects — beliefs the evidence contradicts.

**1. "India-first" describes the roadmap, not the product.** Every production number is a US Twilio
DID. Every production call ran an English-first stack. The most elaborate template in the catalogue is
US-only by design and enabled on two thirds of insurance orgs. The India insurance path is hard-blocked
by our own correct gate with no route to unblocking on Twilio. What is deployed is a **US outbound
insurance dialer with an unexercised India-capable subsystem attached.** That may well be the right
product — it is the one with legal delivery, real margins, and 25 calls of evidence — but the docs, the
prompts, and the pricing all describe a different one.

**2. Compliance-first and India-first currently contradict each other.** The compliance moat is real:
DNC with no bypass, consent records, opt-out events, calling windows, FTSA attempt caps, producer
licensing, the audit-trail export. Almost all of it is **US** law, and all of it runs on Twilio. India
compliance is a *telephony relationship* problem — 1600-series allocation, DLT registration, per-call
DLT logging — and we have the gate but not the relationship. Being compliance-first in India means
being an Exotel customer before it means writing another check.

**3. Our Indic model supplier is now our competitor, and the India price floor moved.** Sarvam has
opened its own conversational voice-agent platform ("Samvaad") to public self-serve access (Inc42
exclusive; also reported by BFSI Elets and startupfeed). We plan to resell a margin on top of the
application layer of the company whose model we depend on. Separately, **Bolna raised $6.3M (₹57.3 Cr)
seed led by General Catalyst, announced 21 January 2026** (YC and Blume existing), positioned verbatim
on "India's scale, linguistic complexity, and cost sensitivity." Gnani.ai is launching five new agents.
India all-in retail sits at roughly ₹1–15/min with a ₹3–5/min budget tier and at least one operator
reporting ₹2/min on Sarvam (search-level, vendor/community sourced, not primary). Our locked India
Starter is ₹2,499/357 min ≈ **₹7/min effective** — above the budget tier we would be compared against,
and its margin only works at all if Sarvam is the default, which F3 shows it is not.

**4. Global pricing, by contrast, has real headroom.** US/global voice AI runs $0.05–0.10/min entry,
$0.08–0.30/min typical, $0.25–0.50 managed, up to $2.00 premium; an independent teardown puts full
pipeline COGS near $0.029/min. Our ~$0.06/min all-in is comfortably inside that. **The same COGS
number that prices us out of India's budget tier is a healthy margin in the US.** The market that
economics points at is not the market the code comments name.

**5. Prompt architecture will not survive the matrix it is heading into.** One template = one prose
blob (up to 19,480 characters), with market, jurisdiction, currency, licensing and language rules
expressed as English sentences inside it. The dimensions are vertical × market × language, and only
vertical is a real field (ADR-031's vertical-agnostic seam). That is precisely why F9 happens, and it
gets worse with every market added. The composition layer already exists — `agent.ts:363-429` builds
the prompt from labelled segments — so the fix is to move market/jurisdiction/currency out of the blob
and into segments resolved from data, not to rewrite nine templates.

**6. One thing we are right about, worth defending.** One fixed spoken language per call, no mid-call
switching (`language-support.md`, ADR-060) is the correct call, for the reasons stated: voice identity,
latency, mid-stream stability. Code-switching belongs in *understanding* (Deepgram `multi`, Sarvam
`codemix`), and that is where it is. Do not let a competitor's "dynamic language switching" bullet
reopen this.

---

## 8. What I could not verify

Stated plainly so nothing here gets over-read:

- **No provider keys in this environment.** `/home/user/.env` holds `GITHUB_TOKEN` only. Nothing in
  §4 was measured on Weeber audio; every WER figure is paper-cited and every price is vendor- or
  community-published.
- **Production env is unconfirmed:** `LLM_PROVIDER`, `AI_GATEWAY_MODEL`, `GROQ_MODEL`, and critically
  **whether `SARVAM_API_KEY` is set in Railway**. `docs/voice-quality/language-support.md` asserts
  "Weeber prod: live as of 2026-07-19"; that is a doc claim, not an observation. If the key is *not*
  set, F3 is worse than described — the smart default is dead code in production rather than
  unreached code.
- **The deployed commit cannot be fingerprinted.** `api.weeber.ai` returns 404
  `DEPLOYMENT_NOT_FOUND`; there is no health/version route. All production-behaviour statements are
  inferred from `main` at `8498e58` plus DB rows.
- India price-ceiling figures are search-result level, not primary. The TRAI Direction and the arXiv
  paper *are* primary and were fetched directly.

---

## 9. Recommended sequence

Ordered by what unblocks what, not by size.

1. **Decide the primary market for the next 90 days in writing, and let the code state it.** My
   read: **US-first for the pilot** — it is what is built, legal, and evidenced — with India as a
   deliberate second market gated on a telephony relationship. Whatever you decide, F2 must be closed
   either way. → **ADR-095**.
2. **Make market a first-class field** (ADR-095): `orgs.market` (+ optional per-agent override)
   driving compliance pack selection, template eligibility, prompt currency, default language,
   provider default, and pricing plan family. Keep the callee-prefix check — demote it from source of
   truth to a **mismatch detector** that flags an org dialling outside its declared market.
3. **Add `template_key`, `agent_config_id`, `language` to `calls`.** Additive, one migration, and it
   is the precondition for ever answering §3, §4, §6 or §7 with data.
4. **If India is in scope at all: get one Exotel BYO number with DLT + 1600-series registration on one
   org.** Until that row exists with `number_series = '1600'`, the India insurance vertical is a slide,
   not a product, and no amount of code changes that.
5. **Set `language` explicitly on all 17 configs; make the field a select.** Then default
   India-market insurance agents to `hi`/`hinglish` (which routes them to Sarvam) and re-measure —
   on our own audio, before quoting anyone's WER table.
6. **Resolve the disclosure-coverage decision** (STOP-AND-ASK): extend to the remaining eight
   languages, or narrow the picker to `en`/`hi`/`hinglish`. Also decide whether "drafts pending human
   review" should be spoken on real calls.
7. **Resolve F7 explicitly: services or self-serve.** If self-serve, the merchant authoring path is
   the gap and the pricing is coherent. If services, the pricing page is describing a product we do
   not sell.

No code changed. One ADR proposed (095, for item 2). Items 1, 4, 6 and 7 are yours to decide, not
mine.
