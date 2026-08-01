# Engineering notes — Shopify COD Confirmation agent

> **Not seeded.** `database/seed.ts` loads only the files named in `AGENT_TEMPLATES[].fileName`, all of
> which live in `docs/agent-prompts/` itself. Nothing in `notes/` ever becomes a system prompt.
>
> Same rationale as `01-cart-recovery-agent.notes.md` (G1.4): the persona file is loaded verbatim into
> `agentTemplates.defaultPersonaPrompt` and paid for on every turn of every call, so it is now agent-facing
> only. Variable tables, source paths, DB column names, dated asides and open engineering questions live
> here.

## Trigger and schedule

| | |
|---|---|
| Webhook | Shopify `orders/create` where `payment_gateway_names` includes cash-on-delivery, or `financial_status` is `pending` (`integrations/shopify/routes.ts`) |
| Workflow name | `shopify-cod-confirmation` |
| Template key | `shopify-cod-confirmation` (`database/seed.ts` `AGENT_TEMPLATES`) |
| Default delay | 30 min after the order is placed |
| Max attempts | 3, then `onExhausted` (ADR-030) |
| `defaultTools` | `confirmCodOrder`, `captureField`, `setDisposition`, `setIntent` (`seed.ts:40`) |

## How per-call values reach the agent — and why the prompt has no merge tags

Before G1.3 this persona carried `{{merchant_name}}`, `{{agent_name}}`, `{{product_name}}`,
`{{cod_amount}}`, `{{currency}}`, `{{delivery_days_estimate}}`, `{{order_id}}`, `{{reschedule_date}}` and
`{{reschedule_time}}`, and **nothing rendered any of them** — the persona body was assigned raw, so the
agent could read a literal `{{cod_amount}}` out loud. See `docs/decisions/adr-065-*.md` for why rendering
the persona was rejected in favour of values-not-placeholders.

| Value | How the agent learns it now |
|---|---|
| Agent's own name, the store it represents | `buildIdentityBlock` (`voice/agent.ts`) — from `orgAgentConfigs.name` and `orgs.name` |
| Customer name, order reference, amount payable, shop, attempt # | `buildWorkflowContextBlock` → `buildWorkflowFactsBlock` (`voice/workflows/variables.ts`), fed from `scheduledCalls.metadata` via `session.workflowMetadata` |
| Anything confirmed during the call | `buildKnownFactsBlock` (`voice/agent.ts`), from `capturedState` |
| Anything from a previous call to this number | `buildCallerMemoryBlock` (ADR-023) |
| Which order the confirm/cancel tool acts on | Bound server-side, never a model input — see below |

Any `{{tag}}` that survives into a composed prompt from any source is stripped by `voice/merge-tags.ts` at
the single `streamText({ system })` call site and logged once.

## Two producer defects fixed alongside this rewrite (G1.3)

Both were silent — the agent simply never learned the two facts the call is *about*.

1. **`buildWorkflowFactsBlock` required `cart_value` **and** `currency` together**, and the COD producer
   (`integrations/shopify/routes.ts`, the `orders/create` context) never wrote `currency`. Net effect: the
   COD confirmation agent could not state the amount payable. Fixed on both sides — the producer now writes
   `currency: String(body.currency ?? "INR")` mirroring the abandoned-checkout context, and the facts block
   now emits a bare amount with an explicit "currency unknown — say the number without naming a currency"
   qualifier if a producer ever forgets again.
2. **The facts block emitted no order reference at all.** The COD and feedback producers write camelCase
   `orderId`; templates and docs use `order_id`. The block read neither. It now reads `order_id ?? orderId`.

**Do not "fix" this by renaming `metadata.orderId` to `order_id`.** `voice/workflows/engine.ts:53` reads
`metadata.orderId` for the post-call Shopify annotate; renaming it breaks the write-back. The resolvers
accept both spellings instead.

## `confirmCodOrder` is server-bound (G1.3, applying ADR-064)

`confirmCodOrder` used to take `{ shop, orderId, confirmed, notes }` — the **model** chose which order to
cancel, from a prompt that (per the defect above) had never been told the order reference. A hallucinated
integer would have cancelled a real, unrelated order in the merchant's store. Worst-case blast radius of
any tool in the codebase.

It is now a factory: `createConfirmCodOrderTool(ctx: CodOrderContext)`, with `ctx` produced by
`resolveCodOrderContext({ metadata })` in `voice/stream.ts` at the `"start"` event. Model-facing input is
exactly `{ confirmed, notes }`. The tool is removed from the static `voiceTools` map and registered per
call in `buildVoiceTools` only when the context resolves — so an inbound call, or any call whose metadata
lacks a usable shop plus a clean positive integer order id, **has no cancel tool at all**. Non-registration
is the enforcement, exactly as with `offerCartRecoveryDiscount`.

`resolveCodOrderContext` reads `shop ?? shop_name` and `orderId ?? order_id`, and rejects anything that
isn't a safe positive integer.

> **Type-inference trap.** Conditional tools must be composed with concrete object shapes applied
> sequentially (`const withDiscount = cartRecovery ? {...base, tool} : base;` then
> `const allTools = codOrder ? {...withDiscount, tool} : withDiscount;`). An inline conditional spread or an
> optional property makes the value type `| undefined`, which propagates into the AI SDK's
> `TypedToolCall<TOOLS>` and produces nine `TS18048: 'call' is possibly 'undefined'` errors across
> `app/routes.ts`, `voice/agent.ts`, `voice/routes.ts` and `voice/synthetic-test.ts`.

## Facts the agent still does not have, and what the persona says instead

| Missing | Producer status | Persona behaviour |
|---|---|---|
| `product_name` | **No producer anywhere in the codebase.** Would need `line_items` extracted from the `orders/create` webhook into the workflow context | Says "your recent order", never names an item |
| `delivery_days_estimate` | No producer, and no merchant-configurable field for it. The old default fallback ("seven to ten") was a made-up number the agent would have stated as fact | Explicitly forbidden from estimating; defers to the store's own order confirmation |
| `reschedule_date` / `reschedule_time` | These are *outputs*, not inputs — captured on the call via `captureField` | Repeats back what the customer said, in full words |

If delivery estimates matter to a merchant, that is a real piece of work: a per-org configurable field
surfaced into the workflow context, not a fallback string in a prompt.

## Explicit decline short-circuits the retry path

An explicit "no" is real information from the customer, not an unknown outcome to retry into, so
`confirmed: false` cancels immediately (`orders/cancel`, `reason: "DECLINED"`) rather than waiting for the
three-attempt `onExhausted` hook. The retry/exhaustion path (ADR-030) still governs genuine
no-answer/busy/failed outcomes, unchanged.

Because the cancel is irreversible and immediate, the persona requires a **second** clear refusal (the
"just to be sure" question) before the tool is called, and routes an unsure customer to the callback module
instead. Tagging failures never block the cancel, and cancel failures are surfaced as
`recorded, canceled: false` rather than a silent no-op — both covered by
`voice/tools/confirmCodOrder.test.ts`.

## Open, not fixed here

- **Disposition enum overloading.** Branch A maps to `"booked"` and Branch B to `"not-interested"` because
  there is no `"confirmed"` / `"cancelled"` pair in the disposition enum. It works, but COD outcomes read
  strangely in analytics. Adding dedicated values is a schema + UI change; decide it deliberately.
- **No `lookupInfo`.** Same as cart recovery — the knowledge base is real and wired, but this template's
  `defaultTools` doesn't include it, so the FAQ list in the persona is the agent's entire knowledge. A
  product decision (latency + live behaviour), not a doc fix.
- **Switch-to-prepaid is not an action.** The persona now only promises to pass the request on. Making it
  real needs a write-back path that doesn't exist.
