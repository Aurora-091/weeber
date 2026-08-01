---
adr: 65
title: "Values, not placeholders — seeded personas carry instructions only; fact blocks carry values; a runtime scrub is the last line of defense"
date: 2026-08-01
status: Accepted
---

## ADR-065 — Values, not placeholders
**Date:** 2026-08-01

**Context:** Every seeded persona in `docs/agent-prompts/` was written as a **template**. They contained
`{{merchant_name}}`, `{{agent_name}}`, `{{product_name}}`, `{{cod_amount}}`, `{{currency}}`, `{{order_id}}`,
`{{cart_items_summary}}`, `{{delivery_days_estimate}}`, `{{reschedule_date}}` and more.

**Nothing rendered them.** `database/seed.ts` loads each file verbatim into
`agentTemplates.defaultPersonaPrompt`; `resolveAgentConfig` assigns that string to `personaPrompt` raw.
The only string in the whole voice path that goes through `renderTemplate` is `literalGreetingTemplate`
(`voice/stream.ts`). The persona body — the thing that governs the entire call — was handed to the model
with the braces still in it. A model reading `The delivery payment will be {{cod_amount}} {{currency}}`
can, and eventually will, read that aloud to a customer.

It got worse on inspection. There were **two independent tag vocabularies that had drifted apart**:

| Source | Tags |
| --- | --- |
| `MERGE_TAGS` (`voice/workflows/graph-types.ts:111-122`), what the canvas and SMS actually resolve | `customer_name`, `cart_value`, `currency`, `checkout_url`, `shop_name`, `attempt_number`, `discount_percent`, `discount_code`, `abandoned_checkout_url`, `cart_recovery_url` |
| The persona docs | `merchant_name`, `agent_name`, `cart_total`, `cart_items_summary`, `product_name`, `cod_amount`, `order_id`, `delivery_days_estimate` |

They overlap on almost nothing. And several persona tags had **no producer anywhere in the codebase** —
`cart_items_summary` and `product_name` are written by no webhook handler, no workflow context, no
migration, nothing. They could never have resolved, under any implementation.

**Decision:** **Values never travel as placeholders. Prompts supply *instructions*; blocks supply
*values*.**

Three parts:

**1. Seeded personas are tag-free and agent-facing only.** A persona says *"the store you represent is
given to you separately as context — use what you are given; if a detail was not given to you, you do not
have it"*. It never contains a slot. `01`, `02` and `03` are rewritten. The six insurance personas
(`04`–`09`) are tracked in `MERGE_TAG_MIGRATION_BACKLOG` in `database/prompt-hygiene.test.ts`, which
asserts the backlog **may only shrink**.

**2. Values arrive through fact blocks that emit a line only when the fact is known.**

| Block | Supplies |
| --- | --- |
| `buildIdentityBlock` (`voice/agent.ts`) | The agent's own name and the store it represents — `orgAgentConfigs.name` + `orgs.name`, the latter newly fetched in a `Promise.all` alongside the template in `resolveAgentConfig` |
| `buildWorkflowContextBlock` → `buildWorkflowFactsBlock` (`voice/workflows/variables.ts`) | Customer name, cart/order value, currency, order reference, shop, attempt number, discount percent and code, recovery URL — from `scheduledCalls.metadata` via `session.workflowMetadata` |
| `buildKnownFactsBlock` | Anything confirmed during this call, from `capturedState` |
| `buildCallerMemoryBlock` (ADR-023) | Anything from a previous call to this number |

An unknown fact produces **no line at all**, rather than a speakable hole. That property is the whole
point: absence is silent, and the persona is written to behave correctly when a fact is absent.

`buildWorkflowFactsBlock` had existed and been unit-tested since the canvas work, but
`buildWorkflowContextBlock` was never called from the live path — the workflow metadata was sitting in the
session and never reaching the prompt. `voice/stream.ts` now captures it call-scoped in the `"start"`
handler and threads it into both `runVoiceAgentTurn` and `runVoiceAgentGreeting`.

**3. A runtime scrub is the last line of defense, and it removes rather than substitutes.**
`voice/merge-tags.ts` exposes `scrubSystemPrompt(prompt, label?)`, applied to the **final composed prompt**
at the single `streamText({ system })` call site in `runVoiceAgentTurn`. One call site covers live calls,
the text test-chat, the synthetic harness and the preview drawer. Any surviving `{{tag}}` — from a
custom persona a merchant typed, a future template, anything — is deleted, the surrounding whitespace
repaired (tag-only lines dropped, doubled spaces collapsed, space-before-punctuation fixed), and the
stripped tag names logged once per call.

**Rejected alternatives:**

| Alternative | Why rejected |
| --- | --- |
| Just render the persona through `renderTemplate` — the obvious fix | The two tag vocabularies don't match, so it would need an alias table mapping `merchant_name`→`shop_name`, `cod_amount`→`cart_value` and so on: a second, hand-maintained, silently-drifting source of truth. And it cannot work at all for `cart_items_summary` / `product_name` / `delivery_days_estimate`, which **have no producer**. Rendering would leave exactly the tags that matter unresolved. |
| Substitute a visible placeholder like `<unknown>` | Turns a silent bug into a spoken one. The model would say "your order for unknown". |
| Substitute a guessed default (e.g. "seven to ten working days" for `delivery_days_estimate`, the value that was actually in the doc) | The agent then states a fabricated fact to a customer with full confidence. A made-up delivery estimate is a promise the merchant has to keep. |
| Fail the call loudly when a tag can't resolve | Refuses a call over a cosmetic gap. The greeting path already takes the softer version of this (falls back to an LLM greeting) and that is the right severity. |
| Leave the persona templated and rely on prompt instructions to "ignore any braces" | Same class of error as ADR-064: advisory instruction guarding a structural problem. |

**Consequences:**

- Engineering context that used to live inside the personas — variable tables, source paths, DB column
  names, dated "known gap" asides, planning-doc references, a competitor jab — moves to
  `docs/agent-prompts/notes/NN-*.notes.md`. Nothing in `notes/` is ever seeded, and
  `prompt-hygiene.test.ts` asserts that no template's `fileName` points inside it. **This is a token
  argument only in part** — measured with `o200k_base`, `01` went 2457 → 1954 and `03` went 1824 → 1569,
  while `02` grew 1725 → 1814 because it gained real guardrails. The saving is real but modest; the actual
  cost was instruction dilution and, in two cases, a persona asserting something false about the product's
  own capabilities.
- `prompt-hygiene.test.ts` is the enforcement: per-file merge-tag checks, an `ENGINEERING_METADATA_PATTERNS`
  scan (source paths, `.ts` filenames, DB table references, competitor names, `Weeber`, dated internal
  notes, planning-doc references), and the shrink-only backlog.
- Two producer defects surfaced while doing this and were fixed in the same pass: the COD workflow context
  never wrote `currency` (and `buildWorkflowFactsBlock` required `cart_value` **and** `currency` together,
  so the COD agent could never state the amount it existed to confirm), and the facts block emitted no
  order reference at all because producers write camelCase `orderId` while everything else says `order_id`.
  Both resolvers now read `order_id ?? orderId`. **`metadata.orderId` must not be renamed** —
  `voice/workflows/engine.ts:53` reads it for the post-call Shopify annotate.
- A seeded `literalGreetingTemplate` containing a tag with no producer is an **invisible permanent latency
  regression**, not just a cosmetic one: `stream.ts` correctly refuses to speak a partially-rendered
  greeting, so the fast canned-greeting path silently never fires and every call pays full LLM
  time-to-first-token on its opening line. `03`'s greeting contained `{{product_name}}` and had been in
  that state since it was written. Removed.
- No migration and no schema change. Seeded persona text updates on the next boot's seed upsert.
- Verified: api tsc ✓ · web tsc ✓ · `bun test --isolate src/` in `packages/api` 810 pass / 0 fail.
