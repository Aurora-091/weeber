# Engineering notes — Shopify Cart Recovery agent

> **Not seeded.** `database/seed.ts` loads only the files named in `AGENT_TEMPLATES[].fileName`, all of
> which live in `docs/agent-prompts/` itself. Nothing in `notes/` ever becomes a system prompt.
>
> **Why this file exists (G1.4, 2026-08-01).** `docs/agent-prompts/*.md` is loaded *verbatim* into
> `agentTemplates.defaultPersonaPrompt` — every byte of it is spoken-agent instruction paid for on every
> turn of every call. It had been doubling as engineering documentation: a merge-variable table naming DB
> columns and webhook fields, dated "known gap" asides, source-file paths, and a competitor jab. None of
> that helps an agent talk to a customer; all of it dilutes the instructions that do, and some of it was
> actively false by the time it shipped (see the knowledge-base note below). The persona file is now
> agent-facing only. Everything an engineer needs is here.

## Trigger and schedule

| | |
|---|---|
| Webhook | Shopify `checkouts/create` / `checkouts/update` (abandoned checkout) |
| Workflow name | `shopify-cart-recovery` |
| Template key | `shopify-cart-recovery` (`database/seed.ts` `AGENT_TEMPLATES`) |
| Default delay | 45 min after abandonment |
| Max attempts | 2 |
| `defaultTools` | `offerCartRecoveryDiscount`, `captureField`, `setDisposition`, `setIntent` |

## How per-call values reach the agent — and why the prompt has no merge tags

Before G1.3 this file's persona contained `{{merchant_name}}`, `{{cart_items_summary}}`,
`{{discount_code}}` and friends, and **nothing rendered them**. Only `literalGreetingTemplate` was passed
through `renderTemplate` (`voice/stream.ts`); the persona body was assigned raw, so the agent could read a
tag out loud to a customer. Rendering the persona was considered and rejected — see
`docs/decisions/adr-065-*.md`. Values now travel as *values*, never as placeholders:

| Value | How the agent learns it |
|---|---|
| Agent's own name, the store it represents | `buildIdentityBlock` (`voice/agent.ts`) — from `orgAgentConfigs.name` and `orgs.name` |
| Customer name, cart value, currency, shop, attempt #, discount % and code, recovery URL | `buildWorkflowContextBlock` → `buildWorkflowFactsBlock` (`voice/workflows/variables.ts`), fed from `scheduledCalls.metadata` via `session.workflowMetadata` |
| Anything confirmed during the call | `buildKnownFactsBlock` (`voice/agent.ts`), from `capturedState` |
| Anything from a previous call to this number | `buildCallerMemoryBlock` (ADR-023) |
| The authorized discount percentage | The `offerCartRecoveryDiscount` tool description itself — bound server-side per call (ADR-064) |

Every one of those blocks emits a line **only when the fact is known**, so an unknown fact is silently
absent rather than a speakable hole. Any `{{tag}}` that survives into a composed prompt from any source is
stripped by `voice/merge-tags.ts` at the single `streamText({ system })` call site and logged.

`cart_items_summary` in particular had **no producer anywhere in the codebase** — nothing ever wrote it. If
line-item detail is wanted on the call, that's a real piece of work: extract `line_items` from the checkout
webhook in `integrations/shopify/routes.ts` and put a summary string into the workflow context so it flows
through `buildWorkflowFactsBlock`. Until then the agent deliberately says "the item you left in your cart".

## Discount authority (ADR-064)

The agent chooses *when* to offer; the merchant chooses *how much*. `percentOff`, `shop`,
`checkoutTokenOrOrderRef` and `prepaidOnly` are bound at session construction from
`scheduledCalls.metadata`; the model's only input is `reason`. When no discount is configured the tool is
**not registered for the call at all**, which is why the persona can safely say "if the tool isn't in your
list, there is no discount."

**COD framing (2026-07-18).** The discount defaults to `prepaidOnly: true` — framed as a prepaid-checkout
incentive. COD is still 40–60% of India ecommerce and carries RTO/refusal risk the merchant only discovers
after the fact, so nudging a recovered cart toward paying online is a second win on top of the recovery.
This is conversational framing only, not a payment-method restriction: Shopify discount codes apply
regardless of the gateway the customer picks, so the agent must never claim the code "won't work" with COD.
A hard restriction would need a Shopify Function or checkout UI extension — out of scope.

## Knowledge base — correcting a stale claim

The persona used to carry: *"there is no knowledge-base upload/storage in the schema or backend yet — treat
any live demo of this section as aspirational."* **That is false as of this writing.** `knowledgeDocuments`
and `knowledgeChunks` exist in `database/schema.ts`, ingestion chunks + embeds in
`voice/knowledge-base.ts`, and `searchKnowledgeBase` is wired behind the `lookupInfo` tool. A stale
disclaimer is bad enough in a doc; in a *persona* it was actively telling a live agent that a capability it
has does not exist.

**Open, not fixed here:** `shopify-cart-recovery`'s `defaultTools` does **not** include `lookupInfo`, so
this agent still cannot query the KB even though the KB is real. The persona has been rewritten to promise
only what the agent can actually do today (answer from what's in its own instructions, otherwise offer a
follow-up). Adding `lookupInfo` to this template is a live-behaviour and latency change and is a product
decision, not a doc fix — decide it deliberately.

## SMS, not WhatsApp

The script offers to resend the checkout link **by SMS** because Twilio SMS
(`voice/workflows/engine.ts`'s `sendSms` action) is the only messaging channel actually wired up. There is
no WhatsApp integration. Twilio does support the WhatsApp Business API, but it is not in this codebase — if
WhatsApp is a launch requirement it is a separate scoped integration. Don't let the agent promise a channel
that doesn't exist.

Note that `sendSms` is **not** in this template's `defaultTools` either — the resend is performed by the
workflow after the call, based on the disposition, not by the agent mid-call. The persona therefore tells
the agent to *offer* the resend and record the outcome, not to call a send tool.
