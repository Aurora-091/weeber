# Audit 12 — the agent list is a view, not a gate: `enabled` and `vertical` are unenforced

**Date:** 2026-08-10
**Scope:** `org_agent_configs` lifecycle — what the merchant-facing agent list shows, what the
call path actually resolves, and what happens to config rows when an org changes vertical.
**Method:** source read of `packages/api/src`, verified against the production database
(`psql`, 4 orgs / 9 templates / 16 config rows). No live call placed.
**Trigger:** the reported symptom "I can't see the new agent in the old accounts".

---

## 0. The reported symptom is not a bug

`insurance-final-expense-qualifier` (seeded 2026-07-19, the newest template) is
`vertical=insurance`. The agent list is produced by `getAgentConfigsForOrg`, which filters on
exactly two things — the org's `vertical` and `active=true` — and merges each template with the
org's config row **or null**. So a template appears in an account whether or not that account
has ever configured it.

Production state:

| org | vertical | created |
|---|---|---|
| krishna35672's workspace | **shopify** | 2026-07-18 |
| presistentads's workspace | insurance | 2026-07-19 |
| rishipawar8999's workspace | insurance | 2026-07-20 |
| krisn | insurance | 2026-08-03 |

All 9 `agent_templates` rows are `visibility='public'`, `owner_org_id=NULL`, `active=true`.

Therefore: the new insurance template **is** visible to all three insurance orgs (including
`presistentads`, created 32 minutes before the template was seeded — provisioning is not
required for visibility), and is **correctly** invisible to `krishna35672's workspace`, which is
a shopify org. Neither ADR-086's visibility columns nor ADR-091's enforcement is involved; every
template is public. Nothing to fix in the reported behaviour.

Two real defects surfaced while confirming this. Both are the same shape as ADR-091 — a
predicate enforced on the browse path and ignored on the execution path — one layer further down.

---

## Finding 1 (P0) — `enabled` is never enforced. The pause toggle is decorative.

`org_agent_configs.enabled` is read in exactly two places in the entire API, both cosmetic:

- `voice/org-queries.ts:374` — `enabledAgentCount` for the setup-status payload.
- `voice/admin-routes.ts:100,111,147` — admin counts and an admin list column.

It is consulted **nowhere on the execution path**:

- `resolveAgentConfig` (`voice/agent.ts:589`) selects the config row at `:612` and reads
  `personaPrompt`, voice, tools, and greeting off it. It never looks at `enabled`.
- `resolvePersona` (`agent.ts:496`) — same.
- `place-outbound-call.ts:53` selects the config row **only** for `phoneNumberId` (caller-ID
  selection). It never looks at `enabled`.
- `stream.ts:2051` resolves the config on pickup for both directions. Never looks at `enabled`.

So an agent a merchant has paused in the UI still resolves its persona, still supplies its voice
and tool set, still answers inbound, and still places outbound. The toggle writes a column that
changes a count on the dashboard and nothing else.

**Confirmed live in production, not theoretical:** `rishipawar8999's workspace` has
`insurance-post-sale-welcome` at `enabled=false`, and that org holds active number
`+17754554413`. That agent is paused in the UI and fully callable.

This is worse than a missing feature, because the UI actively asserts the opposite. `agents.tsx`'s
`classifyReadiness` renders a "Paused" pill from `config.enabled`, so the product tells the
merchant an agent is stopped while the call path treats it as live. For an outbound voice product
under TCPA/DNC, "I turned that agent off" is a compliance claim, and right now it is false.

### The fix is not a one-liner, and one decision is yours

Enforcement does **not** belong inside `resolveAgentConfig`. Four of its callers are deliberate
test surfaces — `test-chat`, `test-call-token`, `test-call-phone`, `synthetic-test`, plus
`compiled-prompt` — and a merchant must be able to test an agent *before* enabling it. Gating
resolution would break the configure-then-verify-then-go-live flow, which is the only flow that
currently exists.

It belongs at the two dispatch boundaries:

1. **Outbound** — `place-outbound-call.ts`, which already reads the row. Refuse to dial for a
   disabled agent. This one is unambiguous: a paused agent must not originate calls.
2. **Inbound** — `stream.ts` on pickup. This one is a **product decision I am not going to make
   for you**: when a call arrives on a number whose agent is paused, do you (a) hang up, (b)
   answer with the org's default persona, or (c) transfer to `humanTransferNumber`? (a) risks
   dropping a real customer, (b) answers with something the merchant never configured, (c) is the
   most defensible but requires a number to be set. Note `phoneNumberId` is only used for outbound
   caller-ID selection today — inbound resolves persona via `numberConfig`/`row.toNumber` — so
   inbound is a smaller blast radius than it first looks, but it is not zero.

Until (2) is decided, shipping (1) alone is a strict improvement and carries no ambiguity.

---

## Finding 2 (P1) — changing an org's vertical orphans its config rows, invisibly

`PATCH /api/app/settings` (`app/routes.ts:304`) accepts `vertical` in its `allowed` list, validates
it against `["shopify","insurance"]`, and writes it with a bare
`db.update(orgs).set(updates)` at `:344`. There is no cleanup step of any kind.

`org_agent_configs` rows keyed to the *old* vertical's templates survive the switch. Production
has three, all on `rishipawar8999's workspace` (now `vertical=insurance`):

```
template_key              tmpl_vertical  enabled  phone_number_id
shopify-cart-recovery     shopify        t        —
shopify-cod-confirmation  shopify        t        —
shopify-feedback          shopify        t        5
```

These are **ghost agents**. `getAgentConfigsForOrg` narrows by the org's current vertical, so they
do not appear in the UI at all: they cannot be seen, edited, or paused. But `resolveAgentConfig`
and `resolvePersona` reach templates through `visibleTemplatesForOrg`, which — deliberately, per
ADR-091 — has **no vertical narrowing**, on the reasoning that a key coming from a stored config
row is already org-scoped. That presumption is exactly what a vertical change breaks. Combined
with Finding 1 (`enabled` unenforced), these rows are reachable, un-pausable, and one of them
holds a caller ID (number 5, `+17754554413`, active).

The FK added in ADR-091 (`0048`) guarantees these rows point at a template that *exists*. It says
nothing about whether that template belongs to the org's vertical. Structural integrity, not
semantic integrity.

### Recommendation

On a vertical change, `PATCH /settings` must run a cleanup in the same transaction: set
`enabled=false` and `phone_number_id=NULL` for every config row whose template's vertical no
longer matches. **Disable, do not delete** — the merchant's persona edits and retry tuning are
their work, and a vertical switch is plausibly reversible or a mis-click. Deleting also drops
`phoneNumberId` bindings that are annoying to reconstruct. Releasing the caller ID is the part
that matters: a number silently bound to an invisible agent is how you lose track of a billable
Twilio rental.

Two supporting changes worth considering:

- Have `getAgentConfigsForOrg` surface off-vertical rows that still exist, as a dismissible
  "left over from your previous setup" group, so cleanup is visible rather than magic.
- Reconsider whether `visibleTemplatesForOrg`'s lack of vertical narrowing is still right. I think
  it is — an in-flight call on a retired or cross-vertical template must still resolve rather than
  fail mid-sentence — but the ADR-091 comment justifying it should be amended to record that the
  "already org-scoped" presumption depends on cleanup existing.

---

## Finding 3 (P2) — `provisionVerticalDefaults` is a no-op for insurance, so provisioning proves nothing

`vertical-defaults.ts:44` defines `insurance: { agents: [], workflows: [] }`. Three of four
production orgs are insurance, so the setup wizard's "Pick agents" step provisions nothing for
them. This is recorded as deliberate ("insurance is effectively pre-configured already",
2026-07-19) and is not itself a bug — visibility does not depend on provisioning (see §0).

It is worth flagging only because it removes a signal: for insurance orgs, the presence or absence
of a config row carries no information about intent. `presistentads` has 5 rows, `krisn` has 6,
`rishipawar8999` has 5 (3 of them ghosts). None of those distributions mean anything, which makes
"is this agent configured on purpose?" unanswerable from the data. Decide the curated insurance
default set, or drop the step for that vertical.

---

## What I did not verify

- No live call was placed. Findings 1 and 2 are source-level plus DB state; the claim "a paused
  agent will answer" follows from the absence of any `enabled` check on the resolve path, not from
  an observed call. The cheapest confirmation is one inbound call to `+17754554413`.
- Whether the deployed build matches the audited source. There is no health/version route on the
  API (`api.weeber.ai` returns Vercel `DEPLOYMENT_NOT_FOUND`), so the running commit cannot be
  fingerprinted from outside. Worth adding regardless — it is the second time in two audits that
  "is prod running this code?" has been unanswerable.

---

## Proposed ADR

**ADR-092 — an agent's `enabled` flag is a dispatch gate, not a dashboard counter.** Covers:
`enabled` enforced at the two dispatch boundaries and deliberately *not* inside
`resolveAgentConfig` (test surfaces must reach paused agents); the inbound-call-to-paused-agent
policy once decided; vertical-change cleanup disabling rather than deleting off-vertical rows and
releasing their caller ID; and an amendment to ADR-091's note on why `visibleTemplatesForOrg`
omits vertical narrowing.

### Status after implementation (same day)

Finding 1 is **fixed and written up** as
[ADR-092](../docs/decisions/adr-092-the-pause-switch-changed-a-dashboard-counter-and-nothing-else.md).
Two things changed versus the plan above, both found while implementing:

1. **One boundary, not two.** `placeOutboundCall` turned out to be the wrong place: its only two
   `agentKey`-passing callers are the test-call-phone endpoints, which must keep working for a
   paused agent, while the real automated dispatch paths pass no `agentKey` at all. The gate lives
   only in `dispatchScheduledCall`.
2. **The vertical check has to fail OPEN on an unknown key.** The scheduler's agent identity is
   `row.persona ?? row.workflowName`, and neither is guaranteed to be a catalog template key —
   `engine.ts:73` writes `persona: workflowName` for arbitrary merchant-named workflows and
   `scaffold.ts` ships `persona: ""`. The first implementation blocked any key not visible for the
   org's vertical and turned 8 existing scheduler tests red; the predicate now checks the key
   exists in `agent_templates` at all before applying the vertical narrowing.

Finding 2 (vertical-change cleanup in `PATCH /api/app/settings`) is **not** implemented, and the
inbound-call-to-paused-agent policy is still open. The 3 production ghost rows are inert for
dispatch in code but were not mutated.
