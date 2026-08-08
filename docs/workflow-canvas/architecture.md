# Weeber Workflow Canvas — Architecture + Bolt Build Prompt

> **STATUS (2026-07-13): BUILT.** This doc was the original architecture/build spec — the canvas
> described below now exists in code: `packages/web/src/web/components/canvas/{WorkflowNode,
> BranchEdge,NodeConfigPanel,NodePalette,types,node-styles,seed-graph}.tsx`,
> `pages/app/workflows.tsx` (merchant, read-only graph + per-node override side panel),
> `pages/dashboard/workflow-editor.tsx` + `workflows-list.tsx` (admin, full drag-drop editor),
> backend routes in `app/routes.ts` (`/workflow-configs`) and `workflows/workflow-templates.ts`,
> schema tables `workflow_templates`/`org_workflow_configs` (migration `0011_grey_scarlet_spider.sql`).
> Audit #04 (`audit/2026-07-13-audit-04-uiux.md`) gave it its first UI/UX review since shipping and
> found + fixed 2 P1 bugs (stale "Saved" state after the first save, fetch errors rendered as
> empty/not-found instead of a real error) — both fixed 2026-07-13. Sections below are kept as the
> original design record, not a current TODO — don't re-spec or rebuild from this doc without
> checking the actual code first.
>
> **Doc map for this feature** (read in this order if you're catching up): this file = original
> spec / what's actually built today. `workflow-canvas-v2-and-multivoice-research.md` = competitor
> research (ElevenLabs, Bolna) + the analytics overlay that shipped from it + a decision log for
> open questions. `workflow-canvas-v3-user-builder-plan.md` = the current forward plan (merchant-
> buildable graphs, not yet built) — **this supersedes §3's "editing permissions" note below**, see
> that doc's §3 for the actual permission model going forward.

## 1. The mapping (why this works)

| Email marketing (Klaviyo/Shopify Flow) | Weeber voice equivalent |
|---|---|
| Trigger (checkout abandoned) | Trigger (checkout abandoned / order placed / fulfilled — already fires today via Shopify webhooks) |
| Wait X hours | Wait/Delay node |
| Send email #1 (no discount) | Voice call attempt #1 (no discount) |
| Conditional Split (opened? clicked?) | Conditional Split on call outcome (answered / no-answer / interested / not-interested / voicemail / etc.) |
| Send email #2 (10% off) | Voice call attempt #2, discount % driven by attempt number |
| Merge tags (`{{first_name}}`, `{{discount_code}}`) | Call context variables injected into the agent's prompt + SMS/webhook templates |

Your workflow engine (`packages/api/src/voice/workflows/`) already has the *branching* half of this built — outcome-based conditional actions (retry/SMS/webhook/DNC) are real and working. What's missing is (a) a database-backed, per-org editable version of that config instead of a single `WORKFLOWS` env var, (b) a variable/merge-tag system so discount % and copy change per attempt automatically, and (c) the visual canvas itself. This doc specs all three; you build it in Bolt.

---

## 2. Data model

Follows the exact template+override pattern already used for agents (`agentTemplates` + `orgAgentConfigs`) — same shape, same merge-at-read-time logic, nothing new architecturally.

```
workflow_templates
  id            text primary key        -- e.g. "shopify-cart-recovery-v1"
  vertical      text not null            -- "shopify" | future verticals
  name          text not null            -- "Cart Recovery" (admin-facing)
  graph         jsonb not null           -- { nodes: [...], edges: [...] } — see §3
  active        boolean not null default true
  created_at    timestamp
  updated_at    timestamp

org_workflow_configs
  org_id         text references orgs(id)
  template_key   text references workflow_templates(id)
  enabled        boolean not null default true
  overrides      jsonb                  -- { [nodeId]: { discountPercent?, delayMinutes?, smsTemplate?, ... } }
  primary key (org_id, template_key)

workflow_runs                            -- NEW — tracks one in-flight execution of a graph for one customer
  id             uuid primary key
  org_id         text
  template_key   text
  context        jsonb not null          -- resolved variables for this run (see §4): customer_name, cart_value,
                                          -- checkout_token, attempt_number, discount_code, etc.
  current_node_id text not null          -- which node this run is sitting at (a wait node waiting to resume,
                                          -- or the node just completed)
  status         text not null           -- "running" | "waiting" | "completed" | "failed"
  next_run_at    timestamp               -- when a "waiting" run should resume (drives the scheduler)
  created_at     timestamp
  updated_at     timestamp

scheduled_calls  -- EXISTING table, one column added
  ...existing columns...
  workflow_run_id  uuid references workflow_runs(id)  -- NEW, nullable — links a scheduled call
                                                        -- back to the graph run that queued it
```

`workflow_runs` is the one genuinely new concept — right now a retry chain is tracked loosely via `scheduledCalls.workflowName` + `attempt`, which works for the simple "one action on one outcome" case but can't represent a real graph with multiple branches and node types in sequence. `workflow_runs` is what lets the engine say "this customer is currently sitting at node `wait-2`, resume into `call-attempt-3` at `next_run_at`."

---

## 3. Node schema (the graph itself)

Standard node/edge graph, same shape react-flow (or any flow-canvas lib) expects natively:

```ts
type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

type WorkflowNode = {
  id: string;
  type: "trigger" | "wait" | "call" | "conditionalSplit" | "sms" | "addToDnc" | "webhook";
  position: { x: number; y: number };   // canvas layout only
  config: TriggerConfig | WaitConfig | CallConfig | ConditionalSplitConfig | SmsConfig | AddToDncConfig | WebhookConfig;
};

type WorkflowEdge = {
  id: string;
  source: string;          // node id
  target: string;          // node id
  /** Only set on edges leaving a conditionalSplit node — which branch this is. */
  branch?: string;          // e.g. "interested" | "no-answer" | "not-interested" | "default"
};

type TriggerConfig = { event: "checkout_abandoned" | "order_placed" | "order_fulfilled" };

type WaitConfig = { delayMinutes: number };   // user-overridable

type CallConfig = {
  persona: string;                                    // which agent template to use for this call
  /** Either a flat percent, or an escalating map keyed by attempt number — the Klaviyo-style
   *  "email 1 = 0%, email 2 = 10%, email 3 = 20%" pattern, applied to calls instead. */
  discountPercent: number | Record<string /* attemptNumber */, number>;
  maxDurationSeconds?: number;
};

type ConditionalSplitConfig = {
  /** Just documents which outcomes this split recognizes — the actual routing is the
   *  outgoing edges' `branch` field, matched against the call's real outcome. */
  outcomes: string[];   // subset of: answered, no-answer, busy, failed, voicemail, interested,
                         // not-interested, callback-requested, booked, no-decision, wrong-number
};

type SmsConfig = { template: string };   // user-overridable — supports {{merge_tags}}, see §4

type AddToDncConfig = { reason: string };

type WebhookConfig = { url: string; payloadTemplate?: Record<string, string> };
```

**Editing permissions (original decision — admin builds, users lightly customize) — still what's
actually live in code today, 2026-07-16:**
- Admin: full graph edit — add/remove/rewire nodes and edges, saved to `workflow_templates.graph`.
- User: cannot touch `nodes`/`edges` structure at all. Their UI only exposes a filtered form of specific fields per node — `discountPercent` (or its per-attempt map), `delayMinutes`, `smsTemplate` text, `maxDurationSeconds` — written to their own `org_workflow_configs.overrides[nodeId]`, never to the template itself. At read/execution time, merge `template.graph` with `override[nodeId]` per node, same merge pattern as `getAgentConfigsForOrg`.

> **Superseded direction (not yet built):** `workflow-canvas-v3-user-builder-plan.md` §3 changes
> this to full merchant-owned graph editing (blank canvas or forked template) via a new
> `customGraph` column, once built. Don't assume that's live — check `orgWorkflowConfigs`'s columns
> directly if it matters for what you're doing.

---

## 4. Variable / merge-tag system

Canonical variables, resolved into a flat `context` object once per workflow run (stored in `workflow_runs.context`, refreshed as new facts become known — e.g. `discount_code` only exists after the call node that generates it has run):

```
customer_name        from Shopify checkout/order payload
cart_value           from Shopify checkout payload
currency              from org
checkout_url          from Shopify checkout payload
shop_name             from org
attempt_number        incremented by the engine each time a `call` node in this run executes
discount_percent      resolved from the current call node's config (flat value, or map[attempt_number])
discount_code         set after `offerCartRecoveryDiscount` tool actually generates one (existing tool,
                      unchanged) — stable/retry-safe, keyed by checkout token, exactly as it works today
```

Two different injection paths, because voice and SMS/webhook consume variables differently:
- **SMS / webhook templates**: simple `{{variable_name}}` string replace, same as any email/SMS merge-tag system. Trivial.
- **Voice agent prompt**: NOT string interpolation into a raw prompt blob — inject as **structured context** the same way `capturedState` already works today (`voice/agent-frame.ts`). Append a clear fact block ahead of the persona prompt, e.g. `Customer: {{customer_name}}. Cart value: {{currency}}{{cart_value}}. If offering a discount this call, offer exactly {{discount_percent}}%, not more.` This keeps the existing "agent reads back known facts" pattern instead of building a second parallel prompt-templating system.

This is also how attempt-based discount escalation actually gets enforced: today the LLM tool `offerCartRecoveryDiscount` accepts any `percentOff` from 1-30 as a free judgment call. Once `discount_percent` is a resolved context variable per attempt, the agent's instructions become "the only percent you're allowed to offer this call is `{{discount_percent}}`" — same tool, now driven by the graph instead of pure model discretion.

---

## 5. Execution engine changes

`engine.ts` today is a single-hop function: call ends → look up `onOutcome[outcome]` → run one action. To walk a real graph:

1. On trigger (existing Shopify webhook handlers, unchanged): create a `workflow_runs` row, `current_node_id` = the trigger node, resolve initial context (customer_name, cart_value, etc. from the webhook payload), advance immediately to whatever node the trigger connects to.
2. A generic `advanceWorkflow(runId)` function replaces the outcome-specific logic: look at `current_node_id`'s type —
   - `wait`: set `status = "waiting"`, `next_run_at = now + delayMinutes`, stop. The existing scheduled-call sweep (`startScheduledCallSweep`, generalized) picks this up when due and calls `advanceWorkflow` again, moving to the next node.
   - `call`: increment `attempt_number` in context, resolve `discount_percent` for this attempt, insert a `scheduledCalls` row with `workflowRunId` set (persona/discount context carried in `metadata`), status `waiting`. When that call completes (existing call-end handler), look up its `workflowRunId`, resolve outcome, then move `current_node_id` to whichever `conditionalSplit` node follows and call `advanceWorkflow` again.
   - `conditionalSplit`: match the just-completed call's outcome against the outgoing edges' `branch` values (fall back to a `"default"` branch if present, else stop the run), set `current_node_id` to the matched edge's target, advance immediately.
   - `sms` / `webhook` / `addToDnc`: execute immediately (reuse the exact logic already in `engine.ts` for these three — don't rewrite them, just call them from the graph walker instead of the old flat switch), then advance to whatever node follows, or complete the run if it's a terminal node.
3. Keep `parseWorkflows`/env-var support as a legacy fallback only if you want zero-downtime migration; the real path for anything with a canvas is `workflow_templates` + `org_workflow_configs` in the DB.

---

## 6. Canvas UI spec (what to actually build in Bolt)

**Two views, same graph, different edit permissions:**

- **Admin canvas** (`/dashboard/workflows/:templateKey`): full react-flow-style editor. Drag nodes from a palette (Trigger, Wait, Call, Conditional Split, SMS, Add to DNC, Webhook), connect edges, click a node to open a config side-panel matching its `config` fields from §3, click a `conditionalSplit` node's outgoing edges to label them with an outcome from the fixed enum. Save writes the whole `graph` JSON to `workflow_templates`.
- **User view** (`/app/integrations` → a "Cart Recovery Flow" card, or its own page): the SAME graph rendered **read-only** (nodes positioned exactly as the admin laid them out, no dragging, no palette) with each node showing a small "Edit" affordance only for its user-overridable fields (discount %, delay minutes, SMS copy). Clicking a `call` node opens a lightweight form (not the full admin config panel) for just `discountPercent`/`maxDurationSeconds`; clicking `wait` opens just `delayMinutes`; clicking `sms` opens just the template text with the merge-tag list shown as a reference. No add/remove/rewire controls anywhere in this view.

**Visual language:** match the existing app exactly (shadcn/ui components, existing card/border/color tokens, no new design system) — the canvas nodes themselves are the only new visual element; everything around them (page header, buttons, side panels) should reuse existing components.

---

## 7. Bolt prompt (archived)

The original copy-paste AI-build prompt used to scaffold this canvas has been moved to `docs/archive/workflow-canvas-bolt-prompt.md` (2026-07-16 docs cleanup) — it's a one-time build instruction, already executed, no longer a useful reference. See §3-§6 above for the actual current data model/node schema/engine behavior.

## 8. What I'd do differently from a straight email-flow clone

- **Don't let users set arbitrary discount % free-form without a ceiling** — keep the existing tool's 1-30% cap enforced server-side regardless of what the canvas UI allows, so a user fat-fingering the form can't accidentally authorize a 90%-off code.
- **Don't make `conditionalSplit` require every outcome to have an edge.** Real customer behavior won't hit every branch — require only a `default` fallback edge so ungraphed outcomes don't silently dead-end a run.
- **Don't rebuild `sendSms`/`addToDnc`/`webhook` execution logic** — the graph walker should call the exact functions already in `engine.ts` for these three actions; only the *routing* (which node runs next) is new.

## 9. Addendum — where this lives (Weeber vs weebersh) + the cart-recovery-link variable

**Build the engine/canvas in Weeber, not weebersh.** weebersh stays a thin OAuth+webhook bridge that executes Shopify API writes on request (calls, SMS, DNC, delays, branching are cross-vertical infra that belongs with Twilio/agents/compliance, all already in Weeber). Discount codes already follow the right pattern and need no architecture change: Weeber calls `POST /api/weeber/discounts/create` on weebersh (confirmed real — `api.weeber.discounts.create.jsx` does the actual Shopify GraphQL write via `createRecoveryDiscount`); Weeber never touches a Shopify token directly. The canvas's `call` node just triggers this same existing endpoint when it needs a code.

**New variable: a cart-recovery link with the discount pre-applied, for the `sms` node.** Shopify's `checkouts/create`/`checkouts/update` webhook payload already includes an `abandoned_checkout_url` field — weebersh already forwards the full, unmodified payload to Weeber (confirmed in `webhooks.checkouts.create.jsx`), so this data already arrives, it's just not captured yet. Shopify's own native abandoned-cart emails compose the final link the same way: append `?discount=CODE` (or `&discount=CODE` if the URL already has a query string) and it auto-applies the discount when the customer clicks through. No draft order, no cart-permalink hacking, no new Shopify scope (`read_checkouts` is already granted).

Two small additions this implies for §3/§4 above:
- **Capture fix (Weeber-side, small) — done.** `abandoned_checkout_url` is captured in
  `integrations/shopify/routes.ts` and stored in the run's metadata/context (confirmed directly in
  code, 2026-07-16 docs cleanup pass — this bullet was an open TODO when originally written, no
  longer is).
- **New canonical variables** (§4): `abandoned_checkout_url` (raw, from the webhook) and `cart_recovery_url` (composed at the moment a discount code is generated: `abandoned_checkout_url + (hasQuery ? "&" : "?") + "discount=" + code`) — the latter is what actually gets used in `sms` node templates, e.g. `"Here's your cart with {{discount_percent}}% off: {{cart_recovery_url}}"`.

This doesn't change the node schema or the Bolt prompt in §7 — it only adds two variables to the merge-tag list and flags one small backend capture fix to do before wiring the canvas to real data.

