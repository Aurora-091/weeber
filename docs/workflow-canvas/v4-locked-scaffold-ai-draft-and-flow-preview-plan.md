# Workflow Canvas v4 — Locked Compliance Scaffold, AI-Assisted Drafting, Flow Preview Call

Status: SHIPPED. Phase 1 (locked scaffold), Phase 2 (AI draft), and Phase 3 (flow preview via
web call) are all built, tested, and on `main` as of 2026-07-19.
Date: 2026-07-18 (Phase 3 shipped 2026-07-19)

> **Reality note (2026-07-19, Phase 3):** §3 below references a `condition` node (branch on cart
> value / tag / etc.). That node type was never implemented — the real `WorkflowNodeType` union
> has `conditionalSplit` as its only branch node. Phase 3's flow preview therefore branches on
> `conditionalSplit` outcomes only. The preview graph-walker is a pure, log-only traversal
> (`voice/workflows/preview-walker.ts`, `walkForPreview`) mirroring `graph-engine.ts`; the live
> call at a `call` node reuses the existing test-call pipeline (test-call-tokens.ts +
> test-call-stream.ts, ADR-051) with zero new socket/wire-format work. Endpoint:
> `POST /api/app/workflow-configs/:templateKey/preview`. UI: "Preview" button + `FlowPreviewPanel`
> in the merchant canvas (branch-picker, storyboard log, inline live call).
Builds on: `workflow-canvas-architecture.md` (original spec/current live behavior),
`workflow-canvas-v2-and-multivoice-research.md` (competitor research + decision log), and
`workflow-canvas-v3-user-builder-plan.md` (merchant-buildable graphs — data model, trigger
catalog, `condition` node type, permission model). **This doc supersedes v3's frontend section
only** (§4 "Frontend — merchant canvas" in v3's build phases) — v3's data model, trigger catalog,
condition-node config, and permission model (`customGraph` column) are unchanged and still the
plan. What changes is the authoring UX itself, plus two new capabilities.

## Why this revision, not straight-to-v3

v3 proposed full n8n-style canvas editing for merchants — a blank/forked canvas, free node
placement, free edge drawing. Reconsidered after two data points:
1. **A direct precedent from this team's own past decision**: on the UpsellX project, a visual
   funnel-canvas direction was built and then explicitly rejected in favor of "One-Click
   Everywhere" — toggle on, rule-based defaults, no drag-drop, no per-placement config. Same buyer
   profile (non-technical SMB owner) as Weeber's merchants.
2. **Dvaarik AI** (a direct India competitor, see chat history / `docs/product-strategy/` — not
   yet written up as its own doc) explicitly rejects self-serve building entirely: "we build it for
   you, you never touch a settings page." The SMB voice-AI buyer segment broadly doesn't want to be
   a workflow author.

Full free-form canvas editing is also a support/compliance liability on its own terms: a merchant
can build a broken graph (dead-end nodes, a call/sms path that never passes a DNC check because
nothing forced one into the graph). Today, nothing stops that — `WorkflowNode` has no `locked`
concept and no seed scaffold exists; an empty `customGraph` really would be empty.

**Decision: keep the visual canvas (merchants do want to see and touch something, not just fill
out a form), but constrain it three ways** — never blank, AI-assisted drafting, and a live
flow-preview call — detailed below. This is consistent with `ADR-033`'s existing principle, not a
reversal of it: agent persona/tone/tools config stays a form (it isn't graph-shaped), but the
trigger/condition/delay/action automation layer stays a visual canvas (it inherently is
graph-shaped) — this doc only changes *who authors that graph and how*, not whether it's visual.

---

## 1. Locked compliance scaffold — no graph is ever truly blank

Add `locked?: boolean` to `WorkflowNode` (`components/canvas/types.ts` and its backend mirror,
`voice/workflows/graph-types.ts`):

```ts
export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: NodeConfig;
  locked?: boolean; // NEW — true for system-seeded compliance nodes
};
```

When a merchant starts a **blank** flow (not forking a template), the canvas is seeded with:

```
[trigger: unconfigured] → [locked: DNC/consent check] → [locked: calling-window check] → [call: unconfigured] → [end]
```

Forking a template keeps the template's existing graph as-is (templates already pass through the
same DNC/calling-window gates today via the engine — see below — this just makes that visible and
non-removable in the merchant's own copy too).

**UI enforcement** (canvas-level, `WorkflowNode.tsx`/`NodeConfigPanel.tsx`): a `locked` node
renders with a distinct visual treatment (e.g. a small lock icon, muted/non-interactive styling),
its delete affordance is disabled, and its incoming/outgoing edges can't be detached from it. A
merchant can freely add nodes *around* it, rewire everything else, but can't remove or reconfigure
the locked nodes themselves.

**Server-side enforcement (the actual guarantee, unchanged from v3 §5):** locked nodes are a UX
signal, not the real safety mechanism — the graph engine already enforces DNC/consent and
calling-window checks at execution time for every `call`/`sms` action, independent of how a
merchant wired their graph (v3 §5, unchanged). The locked-node scaffold's job is making that
visible and hard-to-accidentally-bypass in the *authoring* experience, not creating a new
compliance mechanism. Belt and suspenders, not a replacement for either belt or suspenders.

**Backend validation on save:** reject (400, clear error message) any `customGraph` save where a
locked node ID from the seed scaffold is missing, or where no path from the trigger to any
`call`/`sms` node passes through the required compliance nodes — a determined merchant editing the
raw JSON via devtools/API directly shouldn't be able to bypass what the UI prevents by construction.

---

## 2. AI-assisted drafting — "tell AI to do it"

A prompt box beside the canvas ("Describe what you want this workflow to do"). One LLM call
drafts a graph in the existing typed node/edge JSON shape, which lands directly in the canvas for
the merchant to review, hand-edit, or accept as-is.

**New endpoint:** `POST /api/app/orgs/:orgId/workflows/:templateKey/ai-draft`
```ts
{ prompt: string }
→ { graph: WorkflowGraph } // or { error: string } if generation failed / produced an invalid graph
```

**System prompt context, assembled server-side (never trust the client to supply this):**
- The org's real configured agents (`org_agent_configs`, by `templateKey`) — so the draft can
  reference an actual agent, not an invented persona string
- The vertical-specific trigger catalog (v3 §1) — so the draft only proposes real trigger events
- The exact node/edge JSON schema, plus explicit instruction: **never emit, omit, or modify a
  locked node ID** — the draft is generated *around* the seed scaffold from §1, not instead of it
- The six `condition` node data points (v3 §2) — cart value, tag, order count, discount-used,
  time-of-day/day-of-week, custom field — as the only fields it may branch on

**Validation before returning to the client:** run the exact same backend validation from §1
(locked nodes present and on every required path) against the LLM's output before it ever reaches
the canvas — a malformed or rule-violating draft is rejected server-side and re-prompted or
surfaced as a generation error, never silently handed to the merchant as if it were valid.

**Model/cost:** reuses the existing Vercel AI Gateway relationship (already the LLM provider for
everything else in this codebase) — no new vendor. One-shot generation, not a multi-turn agent;
low frequency (drafting a workflow is a rare action per org, not a per-call cost) so this doesn't
move the unit-economics numbers already locked in `pricing-lock-2026-07-18.md`.

---

## 3. Flow preview via a live web call

Extends the existing Agent Preview drawer's live-test-call pattern (`voice/test-call-stream.ts`,
ADR-051 — a standalone sandbox handler reusing the real STT→LLM→TTS pipeline primitives, no DB
row, no DNC gate needed since nothing's real, 5-minute hard cap, browser mic via a short-lived
token-gated WebSocket) rather than building a second, parallel test-call mechanism.

**What's genuinely new:** today's preview tests *one agent's config* in isolation. A flow preview
needs to walk an actual graph:
- The `call`/`agent` node the merchant is currently sitting at runs live, exactly like today's
  single-agent preview — same pipeline, same codec, same non-persisting sandbox.
- Non-call nodes (`wait`, `condition`, `conditionalSplit`, `sms`, `webhook`, `addToDnc`) can't be
  literally executed in a synchronous 5-minute browser session — a `wait: 45 minutes` node can't be
  waited out. These get **fast-forwarded with a visible log line** in the preview UI ("→ would wait
  45 min here, then retry with 10% off") rather than actually performed.
- Where the graph branches (`conditionalSplit` on call outcome, `condition` on cart value/tag/etc.),
  the merchant picks which branch to walk before starting the preview (e.g. force "no answer" vs
  "interested") — since there's no real disposition/context data in a sandbox call, the merchant
  supplies it, same idea as the existing preview's "unsaved form state" input.

**Scope of the new work:** a preview-mode graph walker (server-side, alongside the existing
`test-call-stream.ts`) that steps through `WorkflowGraph` the same way `graph-engine.ts` does for
real runs, but treats non-call nodes as instant/logged rather than executed, and stops/hands off to
the real STT→LLM→TTS pipeline only when it reaches a `call` node. Locked compliance nodes are
included in the walk (so the merchant sees them fire, reinforcing §1's trust signal) but obviously
don't need a real DNC lookup against a real phone number in a sandbox — log "DNC check: pass
(sandbox)" and continue.

---

## Build phases

**Phase 1 — Locked scaffold + data model (foundation everything else sits on).**
- `locked` flag on `WorkflowNode` (frontend types + backend `graph-types.ts` mirror)
- Seed-scaffold generator (blank-flow starting graph with the two locked compliance nodes)
- `customGraph` column on `orgWorkflowConfigs` (from v3 §3, unchanged)
- Backend save-time validation (locked nodes present, on every required call/sms path)
- Canvas UI: locked-node visual treatment, disabled delete/disconnect on locked nodes
- Verification: typecheck/lint/test/build, plus new tests for the validation logic (accepts a
  valid graph, rejects one missing/bypassing a locked node)

**Phase 2 — AI-assisted drafting.**
- `ai-draft` endpoint + system-prompt assembly (org's real agents, trigger catalog, schema,
  locked-node constraint)
- Reuses Phase 1's validation function against the LLM's output before returning it
- Frontend: prompt box, draft-preview-then-accept-or-discard flow in the canvas
- Verification: tests for the endpoint (valid prompt → valid graph; a prompt that would violate
  locked nodes → rejected/regenerated, not silently returned)

**Phase 3 — Flow preview via web call.**
- Server-side preview graph-walker (steps through `WorkflowGraph`, fast-forwards non-call nodes
  with a log line, hands off to the real pipeline at `call` nodes)
- Branch-picker UI (merchant chooses which `conditionalSplit`/`condition` path to walk before
  starting)
- Reuses the existing token-handshake auth, WS route, and browser audio codec from ADR-051 — no
  new auth/wire-format work
- Verification: typecheck/lint/test/build, plus a test for the graph-walker's fast-forward logic
  (non-call nodes logged not executed, correct branch selected, locked nodes included in the walk)

Each phase is independently shippable and independently useful — Phase 1 alone already closes the
"never blank, compliance can't be silently skipped" gap even before AI drafting or preview exist.
Recommend building in this order (1 → 2 → 3) since Phase 2 depends on Phase 1's validation function
and Phase 3 is the most self-contained of the three (least dependent on the other two, could in
theory be reordered if there's a reason to want flow-preview sooner).
