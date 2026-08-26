# ADR-092: The pause switch changed a dashboard counter and nothing else

- Status: Accepted
- Date: 2026-08-10
- Supersedes: none
- Amends: none
- Related: ADR-091 (visibility was a browse filter, not an authorization
  boundary), ADR-086 (per-org template visibility), ADR-081 (the regulated
  boundary is the product), ADR-088 (a guard with no callers is documentation)

## Context

This came out of a support-shaped question — "I can't see the new agent in the
old accounts" — which turned out **not** to be a defect. `getAgentConfigsForOrg`
lists templates by the org's `vertical` + `active`, merging each with its config
row *or null*; provisioning is not required for visibility. All 9 production
templates are `visibility=public` / `owner_org_id=NULL`, so neither ADR-086 nor
ADR-091 is involved. `insurance-final-expense-qualifier` is
`vertical=insurance`, so it is correctly invisible to the single shopify org and
correctly visible to all three insurance orgs. Nothing to fix.

Confirming that turned up two things that *are* defects (audit 12,
`docs/audits/2026-08-10-audit-12-agent-enablement-and-vertical-drift.md`). This ADR
covers the first.

`org_agent_configs.enabled` has existed since the agents UI shipped. It was read
in exactly two places, both cosmetic:

| site | what it does |
| --- | --- |
| `voice/org-queries.ts:374` | `enabledAgentCount` on the setup-status card |
| `voice/admin-routes.ts:100,111,147` | an admin list column |

It was read in **zero** places on the execution path. `resolveAgentConfig`
(`agent.ts:589`), `resolvePersona` (`agent.ts:496`), `place-outbound-call.ts:53`
and `stream.ts:2051` all ignore it. So the "Paused" pill in the agents UI was
decorative: a merchant who paused an agent still had automated calls placed
under it, still had its persona resolved, still had its caller ID used. In
production right now, `rishipawar8999's workspace` holds
`insurance-post-sale-welcome` with `enabled=f` **and** an active number
(`+17754554413`) — a paused agent that could dial.

For an outbound product that lives under TCPA/DNC and an insurance licensing
boundary (ADR-081), "I turned that agent off" is a compliance claim, not a
preference. It has to be true.

The second defect this predicate absorbs: `PATCH /api/app/settings` accepts
`vertical` and does a bare `db.update(orgs).set(updates)` with no cleanup, so a
vertical switch leaves config rows behind. Production has three —
`rishipawar8999's workspace` (now `insurance`) still holds `shopify-cart-recovery`,
`shopify-cod-confirmation` and `shopify-feedback`, **all `enabled=t`**, the last
holding `phone_number_id=5`. `getAgentConfigsForOrg` narrows by vertical so the
merchant cannot see them — and therefore cannot pause them — while
`visibleTemplatesForOrg` deliberately has *no* vertical narrowing (ADR-091, so an
in-flight call on a retired or cross-vertical template still resolves), which
means the resolver still reaches them. Invisible, un-pausable, dispatchable.

## Decision

`enabled` is a **dispatch gate**, not a dashboard counter. A new predicate
`isAgentDispatchable(orgId, templateKey)` in `voice/org-queries.ts` answers "may
this agent place an automated outbound call right now?", and
`dispatchScheduledCall` consults it as a seventh gate alongside DNC, calling
window, FTSA attempt cap, insurance number series, producer licensing, and the
India DLT number series.

Four sub-decisions, each of which is the interesting part:

**1. Enforced at the scheduler, not in `resolveAgentConfig`/`resolvePersona`.**
Those resolvers are shared with the test surfaces — `test-chat`,
`test-call-token`, `test-call-phone`, `synthetic-test`, `compiled-prompt`. A
merchant must be able to try an agent out *before* enabling it; gating
resolution would break the only configure → verify → go-live flow the product
has.

**2. Not in `placeOutboundCall` either** — which is the counter-intuitive one,
and the reason this took a read of the call graph rather than a guess. Its only
two `agentKey`-passing callers are the test-call-phone endpoints
(`app/routes.ts:631`, `voice/routes.ts:840`), which must keep working for a
paused agent. The real automated dispatch paths (`scheduler.ts:101`,
`app/routes.ts:943` leads/call-now, `voice/routes.ts:313`) pass **no**
`agentKey`. Putting the gate in `placeOutboundCall` would therefore have blocked
exactly the calls that should be allowed and allowed exactly the calls that
should be blocked.

**3. Cancel, do not defer.** A calling window reopens; an FTSA cap rolls over. A
paused agent does not resolve by waiting — someone has to turn it back on. The
sweep sets `status: "canceled"` with `lastBlockReason: "agent_disabled"` plus
detail and `blockedAt`, and the manual Call-now path returns 409 and cancels
rather than releasing the row back to `pending` (where the sweep would only
re-block it, once every 30 minutes, forever). `web/lib/block-reasons.ts` gains an
"Agent paused" label so the Orders page and the admin compliance view say why.

**4. Two deliberate fail-OPEN cases.** These are the ones a naive "just check
`enabled`" refactor gets wrong:

- **No config row at all → dispatchable.** An org that never opened the agents
  UI runs on template defaults, and `getAgentConfigsForOrg` presents `config:
  null` as enabled. Treating absent as disabled would stop every unconfigured
  org's first workflow call.
- **An agent identity that is not a catalog template key → dispatchable.** The
  scheduler's only agent identity is `row.persona ?? row.workflowName`, and
  neither is guaranteed to be a template key: the legacy engine writes
  `persona: workflowName` (`engine.ts:73`) for arbitrary merchant-named
  workflows, the graph engine writes whatever `config.persona` a call node
  carries (`scaffold.ts` ships it as `""`), and `resolveAgentConfig` itself
  treats an unrecognised persona as "no template" and falls through to the
  default prompt rather than erroring. So the predicate checks whether the key
  exists in `agent_templates` *at all* before applying the vertical check —
  failing closed there would have silently cancelled every workflow whose call
  node isn't named after a catalog template. (Caught by the existing scheduler
  suite going 8-red on the first implementation, which is the argument for
  keeping those tests keyed on a non-template persona.)

The vertical-drift check is folded into the same predicate rather than being a
separate gate: if the key *is* a real template, it must still be one this org can
see in its **current** vertical (`visibleTemplatesForVertical`). A leftover
cross-vertical row is not a dispatchable agent.

## Consequences

- A paused agent can no longer place a scheduled or workflow call, and the row
  records why. The pill means something.
- The three production ghost rows are now inert for dispatch **in code**. The
  data itself is untouched — cleanup, and whether `PATCH /settings` should
  disable off-vertical rows and release their `phone_number_id` on a vertical
  change (recommendation: disable, do not delete — the merchant's persona edits
  are their work, releasing the caller ID is the part that matters), is Finding 2
  and is not implemented here.
- `visibleTemplatesForOrg` keeps its lack of vertical narrowing, which is still
  correct for in-flight calls; ADR-091's comment there presumed "already
  org-scoped" was sufficient, and this ADR is the record that the presumption
  depends on cleanup existing.
- **Still open, deliberately not decided:** an *inbound* call arriving for a
  paused agent. Options are (a) hang up, (b) fall back to the default persona, or
  (c) transfer to `humanTransferNumber`. Note `phoneNumberId` is used only for
  outbound caller-ID selection; inbound resolves persona via `numberConfig` /
  `row.toNumber`, so this gate does not touch it today. A merchant who pauses
  every agent while keeping an active number will still be answered.
- `provisionVerticalDefaults` is a no-op for the insurance vertical
  (`vertical-defaults.ts:44`) — Finding 3, P2, unchanged here.

## Verification

`isAgentDispatchable` unit tests in `voice/org-queries.test.ts` (6): disabled row
blocks; enabled row passes; **missing row passes**; a template that exists but is
not visible for the org's vertical blocks; a **non-template** identity passes; a
deleted org blocks. Scheduler tests in `voice/workflows/scheduler.test.ts` (3): a
paused agent is not dialled and is **canceled** with `lastBlockReason:
"agent_disabled"` and no requeue-to-pending; an enabled agent still dials; the
manual Call-now button gets 409 and the row is cancelled.

Gates: `typecheck` ✓ · `lint` 0/0 (479 files) · `test` **1261 pass / 0 fail**
(api 1116, compliance 71, web 74) · `knip:gate` 61/61 baseline ✓.

Not verified: no live call was placed. This is unit-verified only, like ADRs
082–085.
