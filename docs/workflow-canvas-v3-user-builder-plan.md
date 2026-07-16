# Workflow Canvas v3 — User-Buildable Automations (n8n-style)

Status: PLAN — awaiting go-ahead to build. Not started.
Date: 2026-07-16
Builds on: `workflow-canvas-architecture.md` (original spec/current live behavior) and
`workflow-canvas-v2-and-multivoice-research.md` (competitor research + decision log). This doc
also **resolves that doc's §1.4 "Option B"** open question — decided as a new `condition` node
type (see §2 below), not a generalized `conditionalSplit` edge as originally framed there.

## Decisions locked from this round of questions
1. Merchants can build **both** from a blank canvas and by forking a published template.
2. `call` node becomes an **Agent** node — dropdown of the org's real configured agents
   (`org_agent_configs`, keyed by `templateKey`), not a free-text persona string. Keep an
   optional prompt override field for power users, but default is "pick an agent."
3. Real if/else (not just call-outcome branching) needs to evaluate, in order of what you
   confirmed: cart/order value threshold, customer tag/segment, # past orders, discount
   code already used, time of day/day of week, custom field from Shopify/CRM.
4. Trigger catalog expands per vertical — researched below (Shopify confirmed live vertical;
   Clinic/Hotel are on your roadmap per existing multi-tenant-by-vertical decision, so the
   catalog is written for all three now so the schema doesn't need re-touching later).
5. Toggle-off behavior: **ask the merchant at the moment they flip it off** — "Stop new
   automations only" vs "also cancel calls already scheduled/waiting." Two different actions,
   not a single boolean.
6. Priority: go straight for full canvas editing (skip the smaller fast-wins-first path).

---

## 1. Trigger catalog (researched)

Sources: Shopify Flow's own trigger docs, Reddit r/shopify / r/automation COD-NDR workflow
threads, n8n Shopify-automation writeups, and clinic/hospitality voice-AI vendor use-case pages
(DoctorConnect, Whippy, Assort Health, Bland, Oravoice, AwazIndia).

### Shopify / ecommerce vertical
| Trigger | Notes |
|---|---|
| `checkout_abandoned` | already live |
| `order_placed` | already live |
| `cod_order_placed` | subset of order_placed filtered to COD payment method — your existing `shopify-cod-confirmation` scheduler flow should become a first-class trigger here instead of living outside the graph engine |
| `order_fulfilled` | already exists in type, not wired to a real emitting event yet |
| `days_after_delivery(N)` | your ask — needs a delivery-confirmed timestamp source (Shopify fulfillment `delivered_at` via tracking webhook, or fallback N days after `fulfilled_at` if carrier data absent) |
| `order_cancelled` | common NDR/RTO-adjacent trigger, high merchant demand per r/automation COD thread |
| `refund_requested` / `refund_created` | win-back / retention angle |
| `first_time_customer_order` | welcome-flow trigger (classic Shopify Flow example) |
| `product_back_in_stock` | not voice-relevant necessarily, but common in the ecosystem — flag as SMS/webhook-only trigger |
| `high_value_cart_abandoned` | abandoned cart above a merchant-set value threshold — effectively `checkout_abandoned` + condition, but common enough to warrant being a named trigger preset |

### Clinic / healthcare vertical
| Trigger | Notes |
|---|---|
| `appointment_booked` | booking confirmation call/SMS |
| `appointment_reminder(N hours/days before)` | the single most-cited no-show reduction lever across every source found (30-40% no-show reduction claimed industry-wide) |
| `appointment_no_show` | post-no-show reschedule outreach |
| `appointment_cancelled` | rebooking nudge |
| `days_before_appointment(N)` | generalize the reminder trigger to merchant-set N, same pattern as Shopify's `days_after_delivery` |
| `post_visit_follow_up(N days after visit)` | satisfaction/adherence check |
| `waitlist_slot_opened` | fill cancellations fast |

### Hotel vertical (on your roadmap, not yet built — catalog written now to avoid re-touching schema later)
| Trigger | Notes |
|---|---|
| `booking_confirmed` | confirmation call |
| `pre_arrival(N hours/days before check-in)` | upsell + expectation-setting, matches AwazIndia's "24-48hr before arrival" pattern |
| `no_show_at_checkin` | recover/rebook |
| `post_checkout_review_request` | review/feedback call or SMS |
| `booking_cancelled` | win-back |

**Design implication:** trigger config needs to move from a closed string enum to:
```ts
type TriggerConfig = {
  event: string;            // catalog key, e.g. "days_after_delivery"
  params?: Record<string, number | string>; // { days: 10 }
};
```
and a small **admin-owned trigger catalog per vertical** (not fully free-form merchant text —
matches your existing "admin curates, merchant configures" pattern elsewhere in the product).
Each catalog entry declares: label, required params (with type + validation, e.g. `days: 1-60`),
and which vertical(s) it's valid for. This is a new small config table or a static per-vertical
JSON module — cheap either way, worth deciding at build time based on how often you expect to
add new triggers (static file if rare, table if you want it admin-editable without a deploy).

---

## 2. New/changed node types

| Node | Change |
|---|---|
| `trigger` | parameterized event (see above), catalog-driven dropdown + params form instead of hardcoded enum |
| `call` → rename **`agent`** | dropdown of org's `org_agent_configs` rows by `templateKey`; optional prompt override |
| `conditionalSplit` → split into two | keep existing call-outcome branching as-is (it's a different, valid thing — routing on how a call ended). Add a new **`condition`** node type for the actual if/else ask: field + operator + value against workflow `context`, evaluated against the 6 data sources you picked (cart value, tag, order count, discount-used flag, time-of-day/day-of-week, custom field). |
| `wait`, `sms`, `addToDnc`, `webhook` | unchanged, already generic enough |

`condition` node config shape (safe, no free-text expression eval — avoids the compliance risk
flagged for "Option C" LLM-condition edges, and avoids arbitrary code execution risk generally):
```ts
type ConditionConfig = {
  field: "cart_value" | "customer_tag" | "past_order_count" | "discount_used" | "time_of_day" | "day_of_week" | `custom.${string}`;
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains";
  value: string | number;
};
```
Two outgoing edges per condition node: `true` / `false` branch — same edge-branch mechanism
`conditionalSplit` already uses, no new engine primitive needed there.

---

## 3. Permission model for merchant-editable graphs

Today: one `workflowTemplates` row (admin-owned) + one `orgWorkflowConfigs` row per org
(enabled + value overrides only, same shared graph topology).

Needed: an org can now **own its own graph**, either:
- forked from a template (copy `graph` jsonb into a new org-scoped row, org edits freely from there), or
- built from a blank canvas (empty `graph`, same row shape).

Cleanest fit into what exists: give `orgWorkflowConfigs` an optional `customGraph` jsonb column.
- `customGraph` null → org runs the template's graph, unchanged (today's behavior).
- `customGraph` set → org runs their own graph, engine reads this instead of the template's.
This avoids a whole parallel "org_workflow_templates" table and keeps the enable/disable and
override machinery you already have. Same UI (`app/workflows.tsx`) just gets full node
palette + drag/connect rights instead of value-only editing, writing into `customGraph` instead
of `overrides` once a merchant starts actually restructuring the graph.

Admin's template library stays exactly as-is — it's the "readymade starting points" catalog,
untouched by merchant forks (merchant fork is a copy, not a live link back to the template).

---

## 4. Toggle-off UX (per your answer)

On flipping a workflow to off, show a small confirm dialog:
- "Stop new automations" (default) — `enabled = false`, existing `workflow_runs` in `waiting`/
  `running` status keep going untouched.
- "Also cancel in-progress runs" — same flag flip, plus mark all `waiting`/`running` runs for
  this org+template as `failed`/cancelled and cancel any not-yet-fired scheduled calls tied to them.

Needs one new endpoint (or an extra param on the existing enable/disable PUT) plus a query to
find/cancel the affected `workflow_runs` + `scheduled_calls` rows.

---

## 5. Compliance guardrail (non-negotiable, applies regardless of who authors the graph)

Whether a graph is admin-published or merchant-built, every path that reaches a call/SMS action
still passes through the existing DNC/consent checks server-side in the engine — this is
enforced at execution time, not authoring time, so it can't be bypassed by how a merchant wires
their nodes. No change needed here beyond confirming (at build time) that the engine's DNC gate
sits in `advanceWorkflow`'s shared call/sms action handling, not duplicated per node type.

---

## 6. Build phases

1. **Data model**: `customGraph` column on `orgWorkflowConfigs`; parameterized `TriggerConfig`;
   new `condition` node type + config; trigger catalog module (per-vertical).
2. **Engine**: graph-engine reads `customGraph ?? template.graph`; condition node evaluation
   against `context` (cart_value, tags, past_order_count, discount_used, time-of-day/day-of-week,
   custom.*); wire `cod_order_placed`/`days_after_delivery`/etc. as real emitting events (Shopify
   integration routes) alongside the existing `checkout_abandoned`/`order_placed`.
3. **Agent node**: swap `call` config's persona free-text for `agentTemplateKey` referencing
   `org_agent_configs`; migrate existing template graphs' `persona` strings to a "custom prompt"
   fallback so nothing already live breaks.
4. **Frontend — merchant canvas**: reuse `NodePalette` + `WorkflowNode` + `ReactFlow` editing
   (already built for admin) on the merchant side, gated to write into `customGraph`; add
   "start from template" vs "start blank" entry flow; add condition-node config UI; add
   agent-picker dropdown; add the toggle-off confirm dialog.
5. **Verification**: typecheck/lint/test/build green, plus a couple of new engine tests for
   condition-node branching and for the on/off-with-cancel path.

This is a genuinely multi-file, multi-day-shaped feature (schema + engine + two frontends +
new compliance-adjacent execution paths) — bigger than anything shipped in one sitting so far
on this project. Want me to start on phase 1 (data model + trigger catalog + condition node
type) now, or do you want to review/adjust this plan first?
