---
adr: 66
title: "A tool that acts on a real-world entity is bound to that entity server-side — the model never names the target"
date: 2026-08-01
status: Accepted
---

## ADR-066 — The model never names the target of a destructive action
**Date:** 2026-08-01

**Context:** ADR-064 removed the model's authority over the discount *amount* on the grounds that it spends
the merchant's money. The same audit pass, applied to the rest of the tool surface, found a strictly worse
case that ADR-064 didn't cover.

`confirmCodOrder` took:

```ts
{ shop: string, orderId: number, confirmed: boolean, notes?: string }
```

`confirmed: false` calls Shopify `orders/cancel` with `reason: "DECLINED"` — **immediately and
irreversibly**. The model chose `shop` and `orderId`.

Two facts make this the highest blast-radius tool in the codebase:

- **The model had no way to know the right answer.** Per ADR-065, the COD persona's `{{order_id}}` never
  rendered, and `buildWorkflowFactsBlock` emitted no order reference at all (it read `order_id`; the
  producer writes `orderId`). So the agent was being asked to supply an order number it had never been
  told. The only available behaviours were: ask the customer to read it out, or invent one. A
  plausible-looking invented integer cancels a **real, unrelated, in-flight order** belonging to another
  customer of the same store.
- **`shop` was a cross-tenant write surface.** A model-supplied shop domain, on an inbound call, reachable
  by prompt injection.

Nothing in the system would have flagged either. The tool would return `{ recorded: true, canceled: true }`
and the call would close normally.

**Decision:** Generalize ADR-064 from money to **identity**: *any tool whose effect lands on a specific
real-world entity — an order, a customer, a policy, a store — has that entity bound server-side at session
construction. The model supplies only the judgement it is genuinely the right author of.*

For `confirmCodOrder` (`voice/tools/confirmCodOrder.ts`):

- `createConfirmCodOrderTool(ctx: CodOrderContext)` — a factory, same pattern as
  `createOfferCartRecoveryDiscountTool` and `createLookupInfoTool`.
- Model-facing schema is exactly `{ confirmed: boolean, notes?: string }`. `shop` and `orderId` are closed
  over. If a model emits them anyway they are ignored — the bound values win, asserted by test.
- `resolveCodOrderContext({ metadata })` runs once per call in the `"start"` handler in `voice/stream.ts`.
  It reads `shop ?? shop_name` and `orderId ?? order_id`, and returns `undefined` unless it has a shop
  **and** an order reference that parses to a safe positive integer.
- The tool is removed from the static `voiceTools` map and registered in `buildVoiceTools` only when the
  context resolves. **Non-registration is the enforcement** (ADR-064): an inbound call, or a
  cart-recovery call, or any call with incomplete metadata, has no cancel tool in its request at all.
- The description now states plainly that the agent does not identify the order and that a decline cannot
  be undone.

The persona carries the matching conversational safeguard: a cancellation requires the customer to refuse
**twice** (the "just to be sure — cancelling means the order won't be shipped" question), and an unsure
customer is routed to a callback rather than a cancellation. That is a soft control layered on top of the
hard one, not a substitute for it.

**Rejected alternatives:**

| Alternative | Why rejected |
| --- | --- |
| Keep `orderId` as a model input, now that ADR-065 actually gives the agent the order reference | Fixes the *information* gap but not the *authority* gap. The model would be reading a correct number out of its context and re-typing it into a tool call — a pure transcription step with a nonzero error rate and an irreversible failure mode. There is no upside to the round trip. |
| Validate the model's `orderId` against the bound one and reject on mismatch | Same outcome as binding, plus a new error path the agent has to handle mid-call, plus the question of what to say to the customer when it fires. Binding makes the failure impossible instead of recoverable. |
| Keep it model-supplied and add a confirmation turn ("shall I cancel order one two three four?") | The customer cannot verify a number the agent may have invented. It converts a silent wrong cancellation into a wrong cancellation the customer verbally approved. |
| Make the cancel a queued action a human approves in the dashboard | Defensible, and genuinely better for a high-volume merchant — but it changes the product promise (COD confirmation stops being automatic) and needs a review queue that does not exist. Revisit if a pilot merchant asks for it. |
| Soft-cancel: tag the order `cod-declined` and let the merchant cancel | Same objection. Also leaves the RTO the flow exists to prevent. |

**Consequences:**

- The COD agent cannot cancel anything on a call whose metadata is incomplete. That is the intended
  failure mode: it will confirm, capture, and close, and the merchant sees a call with no cancellation
  rather than a cancellation of the wrong order.
- `synthetic-test.test.ts`'s `VALID_TOOL_NAMES` gains `confirmCodOrder` explicitly, alongside `lookupInfo`
  and `offerCartRecoveryDiscount`, because it is no longer in the static `voiceTools` map. As with the
  discount tool, a synthetic AI-to-AI run deliberately gets no bound context, so it can never cancel a
  real order.
- The same type-inference constraint recorded in ADR-064 now binds **two** conditional tools. They must be
  composed as concrete object shapes applied in sequence
  (`const withDiscount = cartRecovery ? {...base, tool} : base;` then
  `const allTools = codOrder ? {...withDiscount, tool} : withDiscount;`). An inline conditional spread or
  an optional property widens the value type with `| undefined` and produces nine
  `TS18048: 'call' is possibly 'undefined'` errors across `app/routes.ts`, `voice/agent.ts`,
  `voice/routes.ts` and `voice/synthetic-test.ts`. Do not "simplify" this.
- Remaining tools were checked against this rule. `captureField`, `setIntent`, `setDisposition`,
  `flagGuardrailEvent` and `lookupInfo` act on the current call or the org's own KB, not on a
  model-named external entity, and are unaffected. **`bookAppointment` and `crmSync` (insurance
  templates) have not been audited against this rule** — do that before the insurance vertical takes a
  live call.
- No migration, no schema change.
- Verified: api tsc ✓ · web tsc ✓ · `bun test --isolate src/` in `packages/api` 810 pass / 0 fail, of which
  21 in `confirmCodOrder.test.ts` (the 8 original behaviour tests preserved, plus 4 on model-input shape
  and bound-value precedence and 9 on `resolveCodOrderContext` refusing anything it isn't sure of).
