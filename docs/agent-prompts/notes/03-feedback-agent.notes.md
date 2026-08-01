# Engineering notes — Shopify Post-Delivery Feedback agent

> **Not seeded.** `database/seed.ts` loads only the files named in `AGENT_TEMPLATES[].fileName`, all of
> which live in `docs/agent-prompts/` itself. Nothing in `notes/` ever becomes a system prompt.
>
> Same rationale as `01-cart-recovery-agent.notes.md` (G1.4): the persona file is loaded verbatim into
> `agentTemplates.defaultPersonaPrompt` and paid for on every turn of every call, so it is now agent-facing
> only.

## Trigger and schedule

| | |
|---|---|
| Webhook | Shopify `orders/fulfilled` (`integrations/shopify/routes.ts`) |
| Workflow name | `shopify-feedback` |
| Template key | `shopify-feedback` (`database/seed.ts` `AGENT_TEMPLATES`) |
| Default delay | 3 days after fulfillment |
| Max attempts | 1 — a missed call means no feedback this time, no retry |
| `defaultTools` | `captureField`, `setDisposition`, `setIntent` (`seed.ts`) |
| `active` | `true`, confirmed 2026-07-18 |

## Design assumptions (still standing)

This agent was drafted without a reference sample, unlike 01 and 02. Three choices are deliberate and worth
re-opening only on evidence:

- **A spoken 1-to-5 rating**, not open-ended sentiment only. Easiest thing to capture reliably over voice
  and the only form that aggregates into a dashboard metric later.
- **No incentive for feedback or reviews.** Adding one is a real product decision with margin implications,
  not a prompt tweak.
- **Negative feedback surfaces, it does not resolve.** This agent has no refund or replacement tool and
  should never behave as if it does.

## How per-call values reach the agent — and why the prompt has no merge tags

Before G1.3 the persona carried `{{merchant_name}}`, `{{agent_name}}`, `{{product_name}}` and
`{{order_id}}`, none of which were rendered — the persona body was assigned raw. See
`docs/decisions/adr-065-*.md`.

| Value | How the agent learns it now |
|---|---|
| Agent's own name, the store it represents | `buildIdentityBlock` (`voice/agent.ts`) |
| Customer name, order reference, shop, attempt # | `buildWorkflowContextBlock` → `buildWorkflowFactsBlock` (`voice/workflows/variables.ts`) — the order reference now resolves from the camelCase `orderId` this producer actually writes (G1.3) |
| Anything captured during the call | `buildKnownFactsBlock` (`voice/agent.ts`) |
| Anything from a previous call to this number | `buildCallerMemoryBlock` (ADR-023) |

`voice/merge-tags.ts` strips any `{{tag}}` that survives into a composed prompt, at the single
`streamText({ system })` call site.

## `product_name` has no producer — and it was also costing a fast greeting

`product_name` is written **nowhere in the codebase.** Nothing extracts `line_items` from the
`orders/fulfilled` webhook. The persona now says "your recent order" and is explicitly forbidden from
naming a product.

The same tag was also in this template's `literalGreetingTemplate` (`seed.ts`), and that one *is* rendered
— through `renderTemplate` at `voice/stream.ts`. The guard there is sound: if any `{{tag}}` survives
rendering, `literalGreetingText` stays undefined and the call falls back to an LLM-generated greeting. So
nothing broken was ever spoken. But because `product_name` could never resolve, **the fast canned-greeting
path never once fired for this agent** — every feedback call silently paid full LLM time-to-first-token on
its opening line, and nothing logged it. The seed greeting is now tag-resolvable
("Your recent order was delivered…"), so the fast path actually engages.

Worth generalizing: a seeded `literalGreetingTemplate` containing a tag with no producer is a permanent,
invisible latency regression. `database/prompt-hygiene.test.ts` is the place to add that check if another
one appears.

## The feedback producer's workflow context

`integrations/shopify/routes.ts` (the `orders/fulfilled` branch) writes `to_number`, `customer_name`,
`shop_name`, `orderId`, `attempt_number`, `discount_percent`. No `cart_value`, no `currency`, no product
name. That's acceptable for this agent — it doesn't need the order value — so no currency was added here,
unlike the COD producer.

## Escalation is manual, and the persona no longer over-promises

There is still **no automated escalation path.** A negative-feedback call lands in the normal call
transcript and `capturedState`, readable by whoever opens the admin panel's calls list. Nothing pings
anyone. The persona has been tightened accordingly: it says the feedback is recorded and passed on, never
that someone will call back by a particular time, and never that a refund or replacement will happen.

If real-time alerting on negative feedback (Slack ping, urgent flag in the dashboard) matters for launch,
that is a small, separate, currently-unbuilt piece. Decide it before assuming "the team will follow up" is
true in practice.

## Open, not fixed here

- **Disposition enum overloading.** Branch A → `"interested"`, Branch B → `"not-interested"`. Neither means
  "gave feedback". A dedicated `"feedback-positive"` / `"feedback-negative"` pair would read far better in
  analytics but is a schema + UI change.
- **No review-link send.** The persona tells the customer to leave a review on the store's product page
  because there is no link-send action wired for this agent (`sendSms` is not in its `defaultTools`, and
  no review URL exists in the workflow context).
