# Weeber Workflow Canvas — Architecture + Bolt Build Prompt

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

**Editing permissions (per your answer — admin builds, users lightly customize):**
- Admin: full graph edit — add/remove/rewire nodes and edges, saved to `workflow_templates.graph`.
- User: cannot touch `nodes`/`edges` structure at all. Their UI only exposes a filtered form of specific fields per node — `discountPercent` (or its per-attempt map), `delayMinutes`, `smsTemplate` text, `maxDurationSeconds` — written to their own `org_workflow_configs.overrides[nodeId]`, never to the template itself. At read/execution time, merge `template.graph` with `override[nodeId]` per node, same merge pattern as `getAgentConfigsForOrg`.

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

## 7. Bolt prompt (copy-paste this into Bolt)

```
Build a node-based workflow canvas for a voice-AI SaaS dashboard (React + TypeScript + Tailwind + shadcn/ui,
Vite). Use react-flow (@xyflow/react) for the graph itself. Match the existing app's visual language exactly
— shadcn/ui components, existing card/border/color tokens — the canvas nodes are the only new visual element.

Data shape (already decided, don't redesign it):

type WorkflowNode = {
  id: string;
  type: "trigger" | "wait" | "call" | "conditionalSplit" | "sms" | "addToDnc" | "webhook";
  position: { x: number; y: number };
  config: Record<string, unknown>; // shape differs per type, see below
};
type WorkflowEdge = {
  id: string; source: string; target: string;
  branch?: string; // only on edges leaving a conditionalSplit node
};
type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

Per-node config fields:
- trigger: { event: "checkout_abandoned" | "order_placed" | "order_fulfilled" }
- wait: { delayMinutes: number }
- call: { persona: string; discountPercent: number | Record<string, number>; maxDurationSeconds?: number }
  (discountPercent can be a flat number OR a map keyed by attempt number as a string, e.g. {"1": 0, "2": 10, "3": 20}
  — build a UI toggle between "flat %" and "escalating by attempt" modes for this field)
- conditionalSplit: { outcomes: string[] } — outcomes are a fixed enum: answered, no-answer, busy, failed,
  voicemail, interested, not-interested, callback-requested, booked, no-decision, wrong-number, default
- sms: { template: string } — free text with {{merge_tag}} placeholders
- addToDnc: { reason: string }
- webhook: { url: string; payloadTemplate?: Record<string, string> }

Build TWO views sharing the same rendering code:

1. ADMIN CANVAS (full editor):
   - Left sidebar: draggable node palette (one entry per node type above, icon + label).
   - Canvas: react-flow, drag nodes from palette onto canvas, connect edges by dragging between handles.
   - Clicking a node opens a right-side config panel with a form matching that node type's config fields
     exactly as specified above.
   - Edges leaving a conditionalSplit node must be individually labeled with one of the fixed outcome values
     (dropdown on the edge, or on click) — render the label directly on the edge line.
   - A "Save" button serializes the whole { nodes, edges } graph as JSON (this is a mock/stub API call for now
     — just console.log the JSON and show a toast, no real backend wiring needed yet).
   - Provide a "Load example" button that populates the canvas with this exact starter graph (the real
     Shopify cart-recovery flow, 3 attempts with escalating discount):
     trigger(checkout_abandoned) -> wait(45min) -> call(persona: "shopify-cart-recovery", discountPercent: 0)
     -> conditionalSplit -> [answered+interested -> stop (implicit success)]
                            [no-answer/busy/failed -> wait(360min) -> call(discountPercent: {"2":10})
                             -> conditionalSplit -> [no-answer -> wait(1440min) -> call(discountPercent: {"3":20})
                                -> conditionalSplit -> [no-answer -> addToDnc(reason: "cart recovery exhausted")]]
                            ]
                            [not-interested -> addToDnc(reason: "declined cart recovery")]

2. USER VIEW (read-only structure, limited field edits):
   - Same graph, same layout (positions locked, no dragging, no palette, no add/remove/rewire).
   - Each node is clickable ONLY if it has user-editable fields:
     - call node -> small popover/dialog with just discountPercent (both flat and escalating-map modes) and
       maxDurationSeconds — nothing else from the call config.
     - wait node -> small popover with just delayMinutes.
     - sms node -> small popover with just the template textarea, plus a static reference list of available
       merge tags below it: {{customer_name}}, {{cart_value}}, {{currency}}, {{checkout_url}}, {{discount_code}},
       {{attempt_number}}.
   - trigger, conditionalSplit, addToDnc, webhook nodes are NOT editable in this view — clicking them does
     nothing (or shows a read-only summary, no edit controls).
   - A visible "Save changes" button for whatever popovers were edited (again, stub the API call — console.log
     + toast is fine for this build pass).

Don't build any backend/database in this pass — this is UI only, wired to mock data and console.log'd saves.
Don't restyle anything outside the new canvas components. Don't add node types beyond the 7 listed.
```

---

## 8. What I'd do differently from a straight email-flow clone

- **Don't let users set arbitrary discount % free-form without a ceiling** — keep the existing tool's 1-30% cap enforced server-side regardless of what the canvas UI allows, so a user fat-fingering the form can't accidentally authorize a 90%-off code.
- **Don't make `conditionalSplit` require every outcome to have an edge.** Real customer behavior won't hit every branch — require only a `default` fallback edge so ungraphed outcomes don't silently dead-end a run.
- **Don't rebuild `sendSms`/`addToDnc`/`webhook` execution logic** — the graph walker should call the exact functions already in `engine.ts` for these three actions; only the *routing* (which node runs next) is new.

## 9. Addendum — where this lives (Weeber vs weebersh) + the cart-recovery-link variable

**Build the engine/canvas in Weeber (openvent), not weebersh.** weebersh stays a thin OAuth+webhook bridge that executes Shopify API writes on request (calls, SMS, DNC, delays, branching are cross-vertical infra that belongs with Twilio/agents/compliance, all already in Weeber). Discount codes already follow the right pattern and need no architecture change: Weeber calls `POST /api/weeber/discounts/create` on weebersh (confirmed real — `api.weeber.discounts.create.jsx` does the actual Shopify GraphQL write via `createRecoveryDiscount`); Weeber never touches a Shopify token directly. The canvas's `call` node just triggers this same existing endpoint when it needs a code.

**New variable: a cart-recovery link with the discount pre-applied, for the `sms` node.** Shopify's `checkouts/create`/`checkouts/update` webhook payload already includes an `abandoned_checkout_url` field — weebersh already forwards the full, unmodified payload to Weeber (confirmed in `webhooks.checkouts.create.jsx`), so this data already arrives, it's just not captured yet. Shopify's own native abandoned-cart emails compose the final link the same way: append `?discount=CODE` (or `&discount=CODE` if the URL already has a query string) and it auto-applies the discount when the customer clicks through. No draft order, no cart-permalink hacking, no new Shopify scope (`read_checkouts` is already granted).

Two small additions this implies for §3/§4 above:
- **Capture fix (Weeber-side, small)**: the checkout webhook handler (`integrations/shopify/routes.ts`, `/webhooks/checkouts`) currently only pulls `phone` and `total_price` out of the payload — add `abandoned_checkout_url` to what gets stored in `scheduledCalls.metadata` (and later, `workflow_runs.context`) alongside the rest.
- **New canonical variables** (§4): `abandoned_checkout_url` (raw, from the webhook) and `cart_recovery_url` (composed at the moment a discount code is generated: `abandoned_checkout_url + (hasQuery ? "&" : "?") + "discount=" + code`) — the latter is what actually gets used in `sms` node templates, e.g. `"Here's your cart with {{discount_percent}}% off: {{cart_recovery_url}}"`.

This doesn't change the node schema or the Bolt prompt in §7 — it only adds two variables to the merge-tag list and flags one small backend capture fix to do before wiring the canvas to real data.

