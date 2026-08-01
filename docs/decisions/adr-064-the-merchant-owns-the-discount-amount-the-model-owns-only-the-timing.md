---
adr: 64
title: "The merchant owns the discount amount; the model owns only the timing — non-registration as the enforcement mechanism"
date: 2026-08-01
status: Accepted
---

## ADR-064 — The merchant owns the discount amount; the model owns only the timing
**Date:** 2026-08-01

**Context:** `offerCartRecoveryDiscount` is the one tool in the product that spends the merchant's money
on a live call. Until this change its input schema let the **model** fill in every commercially meaningful
field:

```ts
percentOff: z.number().min(1).max(30).default(10),
shop: z.string(),
checkoutTokenOrOrderRef: z.string(),
prepaidOnly: z.boolean().optional(),
```

Three separate failure modes, all of them live-call, all of them silent:

- **`percentOff` gave an LLM authority over margin.** Worse than the ceiling suggests: the
  `.default(10)` meant that any turn where the model called the tool without naming a number quietly
  issued a 10% discount. Nobody configured that 10. It was a schema default that had become de facto
  pricing policy.
- **The merchant was *already* authoring this number, and it was being ignored.** The canvas has a real,
  tested path: `web/components/canvas/NodeConfigPanel.tsx:159-216` (flat, or escalating per attempt —
  `{"1":0,"2":10,"3":20}`) → `pages/app/workflows.tsx:441-464` → `workflows/graph-engine.ts:178`
  `resolveDiscountPercent(config, attemptNumber)` → `workflows/variables.ts:19-29` + `clampDiscount` →
  persisted to `scheduledCalls.metadata.discount_percent` at `graph-engine.ts:200`. The merchant sets it,
  we store it, and then the model was free to say something else.
- **`shop` and `checkoutTokenOrOrderRef` were correctness and tenancy surfaces.** A model-invented
  checkout ref breaks the retry-safety contract (the same call retried must reproduce the *same* code, not
  mint a fresh one per attempt); a model-supplied `shop` is a cross-tenant write surface reachable by
  prompt injection on an inbound call.

This is pre-pilot, so no merchant has been burned yet. That is exactly why it is worth fixing now — it is
a hard-to-reverse trust failure, and the first time it happens it happens on a real store's margin.

**Decision:** **The merchant owns the amount. The model owns only the timing.** Enforced structurally, not
by prompt instruction.

`offerCartRecoveryDiscount` becomes a **factory** —
`createOfferCartRecoveryDiscountTool(ctx: CartRecoveryDiscountContext)`
(`voice/tools/offerCartRecoveryDiscount.ts:62,78`) — the same pattern as `createLookupInfoTool`, bound
once per call from server-side state. `percentOff`, `shop`, `checkoutTokenOrOrderRef` and `prepaidOnly`
are **removed from the model-facing schema entirely** and closed over from context.

The only field left in the input schema is `reason` (`:90-91`) — the hesitation the agent actually heard.
It is the one input the model genuinely is the right author of, it keeps the schema non-empty (some
strict tool-calling providers reject a zero-property object), and it gives the merchant an audit trail on
the call-detail timeline explaining why a discount fired at all. The tool *description* names the exact
bound percentage, so the model can speak the number accurately without being able to choose it.

**Non-registration is the enforcement mechanism.** When a call has no discount configured
(`metadata.discount_percent` absent or `0`), the tool is **not added to that call's tool set at all**
(`voice/agent.ts:718-719`). Not registered-at-0%, not defaulted. A tool that is not in the request cannot
be called — that is the only airtight guarantee that "no discount configured" means "no discount offered."
It also matches the persona doc, which already tells the agent to skip the discount step when none exists.

Resolution happens once per call: `resolveCartRecoveryContext({ metadata, checkoutToken })`
(`:141`) is called in the `"start"` handler (`voice/stream.ts:1480`), stored call-scoped
(`stream.ts:172`), and threaded through `runVoiceAgentTurn({ …, cartRecovery })` (`agent.ts:806,845,865`)
into `buildVoiceTools(orgId, enabledTools, onSlowToolCall, cartRecovery)` (`agent.ts:700-719`). It returns
`undefined` — and therefore registers nothing — if the shop, the checkout ref, or a non-zero percent is
missing. The tool is also removed from the static `voiceTools` map (`agent.ts:594`), so there is no path
left that can hand out an unbound instance.

**Rejected alternatives:**

| Alternative | Why rejected |
| --- | --- |
| Keep the schema default, add a prompt instruction ("never pick your own discount") | Prompt instructions are advisory. This is margin. A jailbreak or a confused turn should not be able to spend money. |
| Register the tool at `percentOff: 0` when nothing is configured | The agent then offers a "0% discount" on a live call — an absurd conversation, and it still burns a Shopify API write. Better that the capability does not exist. |
| Fall back to an org-level default discount | Reintroduces the same bug one layer up: a number nobody consciously set becomes policy. If a merchant wants a default, they set it in the canvas. |
| Let the model propose and the server clamp | Clamping hides the disagreement. The merchant configured 10 and the call gave 30-clamped-to-30; the merchant never learns their setting was overridden. |

**Consequences:**

- `clampDiscount` (`workflows/variables.ts:3-4`, 1–30) is demoted to what it always should have been: a
  sanity bound on *merchant* input, not a guardrail on the model.
- **Text test-chat and the synthetic-test harness never receive this tool** — neither has a real checkout,
  and a synthetic run must never create live Shopify discount codes. `synthetic-test.test.ts`'s
  `VALID_TOOL_NAMES` therefore adds it explicitly alongside `lookupInfo` rather than deriving it from
  `voiceTools`.
- `docs/agent-prompts/01-cart-recovery-agent.md` updated: the Tools row is now
  `offerCartRecoveryDiscount({ reason })` with "You do not choose the discount amount"; Section 3 Step 4
  reads "you decide *when*, the merchant decides *how much*"; the hardcoded "10% off" example is gone.
- **Implementation constraint worth recording** (it cost real time): the conditional registration must be
  written as **two concrete object shapes** — `cartRecovery ? { ...baseTools, offerCartRecoveryDiscount: … } : baseTools`.
  Both an inline conditional spread `...(cartRecovery ? {…} : {})` and an optional property
  (`{ offerCartRecoveryDiscount?: … }`) widen the value type with `| undefined`, which propagates into the
  AI SDK's `TypedToolCall<TOOLS>` and produces 9 × `TS18048: 'call' is possibly 'undefined'` across
  `app/routes.ts:472`, `voice/agent.ts:871-872`, `voice/routes.ts:687`, `voice/synthetic-test.ts:80`.
  Both were tried and reverted; do not "simplify" this branch back.
- No migration, no schema change, no new config surface. This reads state the workflow engine already
  persists.
- Verified: api tsc ✓ · web tsc ✓ · root oxlint 0 warnings / 0 errors (404 files) ·
  `bun test --isolate src/` in `packages/api` 755 pass / 0 fail · `packages/web` 16 pass / 0 fail.
  26 new tests (20 in `offerCartRecoveryDiscount.test.ts`, 6 registration tests in `agent.test.ts`).
