# Archived: Workflow Canvas — original Bolt build prompt

> Moved here from `docs/workflow-canvas-architecture.md` §7 during a docs cleanup pass
> (2026-07-16) — this was a one-time copy-paste prompt for an AI coding tool to scaffold the
> canvas UI. The canvas it describes is built and live (see the parent doc's status banner);
> this prompt has no further use except as a historical record of what was asked for. Kept for
> git history, not a current reference — if you need to know what the canvas actually does
> today, read the real code or `workflow-canvas-architecture.md` §3-§6.

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

