# Workflow Canvas / "Customize" UX Audit #8 — 2026-07-30

**Commit audited:** `2eb819e` (HEAD at audit time), plus the two P0 fixes shipped in the same
session as this doc (see §6).
**Auditor:** Runable agent, on explicit request (CTO/architect mode — evidence over reassurance).
**Scope:** a cold audit of the merchant-facing workflow builder — the Standard (read-only template)
view, the "Customize"/canvas editor, and the AI-draft path — benchmarked against how competing voice
platforms onboard a user into flow-building. This is a UX/product audit grounded in source, not a
live-traffic study: **there are no usage analytics on this flow**, so every claim below is reasoned
from the code and from competitor behaviour, not from observed merchant sessions. That gap is itself
the single highest-value thing to close (see §5).

**Files read for this audit:**
- `packages/web/src/web/pages/app/workflows.tsx` — `UserWorkflowStandardView`, `UserWorkflowCanvasEditor`,
  `UserWorkflowsListPage`, `UserWorkflowDetailPage`, `graphToFlowReadOnly`/`graphToFlowEditable`.
- `packages/web/src/web/components/canvas/NodeConfigPanel.tsx`, `WorkflowNode.tsx`, `NodePalette.tsx`.
- `packages/web/src/web/pages/dashboard/workflow-editor.tsx` (admin template editor — shares the panel).
- `packages/api/src/voice/workflows/{ai-draft,scaffold,engine,graph-engine,graph-types}.ts` and routes
  in `packages/api/src/app/routes.ts`.

---

## 1. What the flow actually is (and why that framing matters)

The canvas is an **orchestration** editor, not a **conversation-flow** editor. Its node vocabulary is
trigger / wait / call / conditionalSplit / sms / addToDnc / dncCheck / callingWindowCheck / webhook
(`graph-types.ts`, `node-styles.ts`). That is the Shopify Flow / Zapier pattern: "when X happens, wait,
call, branch on outcome, send SMS, respect DNC." It is **not** the Vapi/Retell/ElevenLabs pattern of
laying out what the agent *says* turn-by-turn — the persona/script lives on the agent (see the Agents
UI + `resolvePersona` in `voice/agent.ts`), and a call node just *references* an agent by its
`templateKey` via the `persona` field.

This distinction is load-bearing for the recommendation: because it is orchestration, the canvas is a
**legitimate power surface** merchants coming from Shopify already recognise. The mistake is not having
a canvas — it is making the canvas (or a blank one) the *front door*.

## 2. Cold walk-through — the three entry states

**(a) Standard view** (`UserWorkflowStandardView`). A merchant lands on a read-only rendering of the
vertical's template graph. Pre-fix, this looked exactly like an editor (React Flow with Background,
Controls, MiniMap) but only call/wait/sms nodes responded to a click and nothing could be dragged or
connected — a classic "looks interactive, mostly isn't" trap. The affordance fixes shipped earlier
this session (commit `2eb819e`: editable-node pencil cues, orientation strip, conditional Save button,
empty-state CTA) addressed the *legibility* of this state. What remained was that the only ways
*forward* were two manual buttons — "Customize from this template" and "Start blank" — both of which
drop you into raw node wiring.

**(b) Canvas editor** (`UserWorkflowCanvasEditor`). Full node/edge editing, palette on the left,
config panel on the right. This is where the AI-draft "describe your flow" bar lived — **buried one
level in**, only visible *after* a merchant had already committed to the canvas. So the single most
forgiving path (plain language) was gated behind the least forgiving decision (open the canvas).

**(c) AI-draft** (`POST /api/app/workflow-configs/:id/ai-draft`, `ai-draft.ts`). Takes a prompt,
returns a full graph, doesn't persist. Solid endpoint. Under-exposed in the UI.

## 3. The two concrete P0 defects

**P0-1 — the persona "text leak."** In `NodeConfigPanel.tsx`'s `CallFields`, a call node's `persona`
was a **raw free-text `<Input>`** with placeholder `shopify-cart-recovery`. But `persona` is not free
text — the engine treats it as an agent `templateKey` (`graph-engine.ts:191` → `graph-types.ts:58`;
`ai-draft.ts:89` literally constrains the model to "must be one of" the org's persona keys). A merchant
typing anything that isn't an exact existing key produces a call node that silently points at no real
agent. This is a correctness bug wearing a UX costume.

**P0-2 — plain language buried.** As above: the AI-draft bar existed only inside the canvas editor,
so the front door was "wire nodes yourself," not "tell us what you want." Every competitor does the
inverse (see §4).

## 4. Competitive matrix — how the field onboards into flow-building

| Platform | Front door | Canvas role | Persona/script selection |
|---|---|---|---|
| **Vapi** | Prompt + templates first; "describe → generate" | Opt-in advanced visual layer | Assistant picked from a list, never typed |
| **Retell** | Templates + plain-language; ~600ms latency demo-led | Drag-drop flow as advanced layer | Agent selected from configured agents |
| **ElevenLabs** | Prompt/template-led | Advanced, opt-in | Voice/agent from a picker |
| **Bland** | Prompt-led, compliance moat | Pathways as power layer | Referenced, not free-typed |
| **Bolna** (India) | Templates + guided setup | Advanced | Selected |
| **Weeber (pre-fix)** | Read-only template → two manual buttons | **Was effectively the front door** | **Raw free-text templateKey** |

The pattern is unanimous: **lead with prompt/template/plain-language; offer the canvas as an opt-in
advanced layer; never make a blank canvas the first thing; never make the user type an identifier a
picker could supply.** Pre-fix, Weeber was the only one violating all three.

**Decision reaffirmed: keep the canvas.** Killing it would throw away Weeber's one *familiar-to-Shopify*
surface. The canvas is orchestration, which merchants from Shopify Flow already understand — it is a
differentiator when positioned as the power layer, a liability only when positioned as the entrance.

## 5. The real gap behind all of this

There is **no instrumentation** on this flow. We cannot see how many merchants open the canvas vs.
bounce, how many use AI-draft, how many save a custom graph vs. stay on the template, or where they
abandon. Every recommendation in this doc is inferred from code + competitors. **Before P1/P2 work,
instrument the flow** (entry-state chosen, AI-draft used, node edits, save/abandon) — otherwise we're
tuning a funnel we can't see. Flagged as the highest-leverage next step.

## 6. Recommendation → what was shipped this session

**P0 (done this session, same commit as this doc):**
1. **Persona dropdown.** `CallFields` now renders a `<select>` of the org's agents (sourced from
   `GET /api/app/agent-configs`, shared query key `["app-agent-configs"]`) instead of a raw text input.
   Disabled agents are listed but flagged `· off`; a legacy/unlisted persona already on a node is kept
   selectable so opening the panel never silently drops it. The panel stays presentational and
   auth-agnostic: it takes an optional `personaOptions` prop, so the **admin template editor**
   (`dashboard/workflow-editor.tsx`, which uses `apiFetch`+`adminHeaders`, a different auth context)
   falls back to the raw input by simply not passing options — no cross-context fetch coupling.
2. **AI-draft as the front door.** The "describe your flow" bar now sits on the Standard View entry as
   the primary path — type a description → generate a draft graph via the existing `/ai-draft`
   endpoint → land in the canvas editor to review/edit/save. "Customize from this template" and
   "Start blank" remain as manual fallbacks.

**P1 (not this session):** graph validation before save/activate (unreachable nodes, a call node with
no persona, a wait with no downstream, DNC/window checks bypassed). The persona dropdown removes the
most common invalid state but does not validate graph *shape*.

**P2 (not this session):** a template gallery at entry (multiple starting points per vertical) rather
than the single seeded template.

**Prerequisite for tuning any of the above:** instrument the flow (§5).

---

**Verification of the shipped P0 work:** `packages/web` — `tsc --noEmit` exit 0; `vite build` ✓
(8.87s); root `oxlint --deny-warnings` — 0 warnings, 0 errors. No live server booted and no
write-path/call/email test run (staging and prod share `DATABASE_URL`/Supabase/Twilio — not touched).
