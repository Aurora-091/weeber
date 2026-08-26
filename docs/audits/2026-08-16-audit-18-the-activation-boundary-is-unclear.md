# Weeber Automation and Workflow Activation Audit

## From Account Creation to a Verified Automation in Five Minutes

**Date:** 16 August 2026  
**Repository reviewed:** `Aurora-091/weeber`, local `main` at `1f06ebb`  
**Scope:** Sign-in, setup, connection, telephony, workflow authoring, activation, event dispatch, scheduling, test paths, operational visibility, and failure recovery.  
**Assessment mode:** Source review plus existing desktop and mobile visual-regression snapshots. The assessment did not have a seeded live store, carrier account, or production credentials; conclusions about executed workflows are limited to code paths, configured interfaces, and snapshot evidence.

> **Verdict:** Weeber has a promising execution foundation—idempotent webhooks, compliance gates, durable call records, compare-and-swap run updates, and a webhook outbox—but it does **not** currently behave like a five-minute setup product. It behaves like an unfinished workflow platform whose user-facing controls overstate what the runtime honours and whose activation boundary is unclear. The highest-risk issues are functional, not cosmetic: a merchant can edit a trigger that the dispatcher does not use; saving a workflow also enables it; defaults are enabled before the apparent “Review & activate” step; and a merchant cannot inspect a complete run-level explanation when an automation fails or waits.

## 1. The Correct Product Promise

The current product implicitly promises “set up Weeber and your agents react automatically.” That is too broad for the actual dependencies. A Shopify OAuth round trip, a telephony number or carrier credential, regional compliance gates, and a real store event cannot be reliably completed in five minutes for every new business. The product should not disguise those dependencies; it should sequence them.

The viable promise is **five minutes to a verified demo**, followed by a conditional live-launch promise:

| Promise | What the product must make true | Current status |
|---|---|---|
| **Five minutes to a verified automation demo** | A merchant signs in, connects or selects Shopify, gets a recommended draft, runs a deterministic synthetic trigger against a safe test recipient or browser simulation, and sees the outcome trace. | Not supported end-to-end. |
| **Live after Shopify and number readiness** | The merchant completes OAuth, has a valid outbound number, confirms the selected workflow release, and sees compliance/readiness status before live dispatch begins. | Partly supported technically, but activation is not modelled as a clear transaction. |
| **Advanced workflow authoring after activation** | A knowledgeable merchant can fork, version, test, review, release, and roll back a flow without changing historical runs. | The canvas exists, but versioning, trigger dispatch, and release semantics are incomplete. |

The design principle should be simple:

> **The default user does not build an automation. They select an outcome, prove it safely, and deliberately release it.**

Free-form graphs, AI drafting, branch editing, provider choice, and low-level configuration should be progressive-disclosure tools. They should not compete with the first successful outcome. This is consistent with established progressive-disclosure guidance: show the information and controls required for the immediate task, and reveal advanced complexity only when the user asks for it.[1]

## 2. Current Journey and Why It Misses the Goal

The effective Shopify journey is currently:

```text
Sign in / create account
  → email confirmation when required
  → dashboard
  → setup modal: business type and name
  → Shopify OAuth redirect
  → agents step automatically enables defaults
  → connect BYO Twilio or procure a number
  → choose “test mode” or “real customers”
  → review page closes
  → wait for a real store event
  → infer success from Orders / Conversations / dashboard
```

The workflow-authoring journey is separate:

```text
Open Workflows
  → select a template
  → alter values, generate an AI draft, or enter a graph canvas
  → save
  → workflow is enabled as part of the same request
  → use a partial sandbox preview only after entering the custom canvas
```

This has four structural consequences. First, the product makes users solve carrier and OAuth questions before it gives them a deterministic proof that the automation is valuable. Second, the user-visible “Review & activate” screen is ceremonial because the recommended agents and workflow were already enabled at the Agents step. Third, the workflow UI mixes a simple template configuration task with an n8n-like authoring environment. Fourth, a merchant has to wait for a live external event to know whether the automation chain truly works.

| Journey moment | Current behaviour | Why it is defective for fast activation |
|---|---|---|
| Sign-in | Clean password and email-code paths, but no time-to-value forecast or prerequisite disclosure. | The user cannot decide whether they are entering a five-minute demo, a carrier configuration exercise, or a full production launch. |
| Setup | Six logical steps, plus possible email confirmation and an external OAuth redirect. | The product’s stated speed is not tied to a measured, controllable milestone. |
| Agent step | `POST /provision-defaults` enables recommended agents and the cart-recovery workflow as soon as the step is reached. | A workflow can become eligible before the user has completed phone, testing, or final review. |
| Test mode | Changes selected compliance checks for 24 hours. | It is a policy setting, not a test execution. The label invites users to think it proves a workflow. |
| Workflow preview | Fast-forwards waits, SMS, webhooks, and DNC actions; exposes a browser call only at a call node. | It proves a partial graph walkthrough and agent conversation, not webhook receipt, dispatch, provider placement, or durable outcomes. |
| Operations | Orders explains scheduled-call block reasons; the detailed Workflow Runs surface is administrative. | Merchants cannot answer the essential question: “What did this automation do, where did it stop, and what do I do next?” |

## 3. Critical Findings

Severity reflects customer and operational risk, not the amount of code involved. **P0** means the product should not rely on the feature for a production activation path until corrected. **P1** means it materially harms activation, safety, or support load. **P2** means it reduces confidence, accessibility, or efficiency but can follow the contract fixes.

| ID | Severity | Finding | Direct evidence | Business consequence |
|---|---|---|---|---|
| AW-01 | **P0** | The trigger editor and runtime dispatcher disagree. | `NodeConfigPanel.tsx` lets a merchant select checkout abandoned, order placed, or order fulfilled; Shopify `findActiveWorkflowTemplate` selects using the **template** trigger before `graph-engine.ts` resolves `customGraph`. | A merchant can configure a trigger that never causes the custom workflow to run, or expect a changed trigger while the old template trigger remains active. |
| AW-02 | **P0** | Draft, save, and activate are collapsed into one action. | Standard and canvas saves send `enabled: true`; backend blocks activation only when the same request includes an invalid graph. | A user cannot safely persist work, review a diff, test it, or schedule a release without making it dispatchable. |
| AW-03 | **P0** | Long-running runs do not execute against an immutable workflow version. | `advanceWorkflow` and `resumeWorkflowAfterCall` resolve the current `customGraph` at execution/resume time; `workflow_runs` has no workflow-version or graph-snapshot field. | Editing a workflow can change how an already-started, waiting, or post-call run proceeds. This breaks auditability and can produce unexpected customer actions. |
| AW-04 | **P1** | The apparent “Review & activate” step is not the activation transaction. | Defaults are provisioned in the Agents step; review only marks onboarding complete, closes the modal, and routes to the dashboard. | Users cannot understand when live automation starts, undermining trust and compliance expectations. |
| AW-05 | **P1** | The product does not offer one deterministic end-to-end first test. | Flow preview is only accessible in Custom canvas and fast-forwards most actions; test mode only changes gate behaviour. | Merchants wait for a real event or manually infer readiness, creating false negatives and support burden. |
| AW-06 | **P1** | Merchant workflow observability is incomplete. | `workflow_runs` stores status/current node/history but no failure reason; detailed run UI is admin-only; Orders surfaces only `scheduled_calls`. | Users cannot diagnose graph failures, waits, SMS/webhook outcomes, or release/version context. |
| AW-07 | **P1** | The visual workflow builder permits semantics the engine intentionally ignores. | The validator only warns when linear nodes have multiple outgoing edges; the graph engine follows `outgoing[0]`. | A graph can look branched while runtime behaviour depends on edge ordering rather than an explicit merchant decision. |
| AW-08 | **P1** | Unsupported verticals enter a self-service activation flow. | Insurance is selectable in onboarding; `verticals.ts` says Shopify is the only vertical with real agents; insurance has no live integration and empty recommended defaults. | A user can select a business type that may present “No agent templates available” while the wizard requires an enabled agent to proceed. |
| AW-09 | **P2** | Activation recovery is inconsistent. | Phone Numbers and Orders expose Retry; Workflow list currently tells the user to refresh the page. | A transient failure in the central automation surface becomes a dead end rather than an actionable recovery. |
| AW-10 | **P2** | Workflow action completion is not an end-to-end success contract. | SMS errors are caught and the graph continues; webhook enqueue is fire-and-forget and outbox delivery is not tied to run completion. | A run can appear completed without a merchant-readable account of whether every requested terminal action happened. |

### AW-01 — Custom trigger configuration is not honoured by dispatch

This is the clearest functional contract defect. The canvas allows the merchant to select an event on a trigger node. However, inbound Shopify routes call `findActiveWorkflowTemplate(orgId, event)`, which examines the **seeded template graph** to decide which template to dispatch. The graph engine loads the organisation’s custom graph only after that selection. In other words, the UI changes a trigger field that cannot determine dispatch.

This should be fixed before any workflow-builder expansion. Until it is corrected, remove trigger editing from merchant custom flows or render the trigger as “Inherited from Cart recovery” and explain the one supported event. The durable fix is a `workflow_release_triggers` projection keyed by the active release and event type, updated atomically when a release becomes active. Event dispatch must select an active release, not a template followed by a later graph substitution.

### AW-02 and AW-04 — The product has no real release boundary

The current setup contains a review screen, but the actual state transition is scattered. The Agents step provisions defaults; the workflow page saves `enabled: true`; the review screen changes onboarding completion. None of these is a coherent activation transaction.

The remedy is a small, explicit state machine:

| State | Can receive external triggers? | User meaning | Required transition |
|---|---:|---|---|
| **Draft** | No | The configuration is editable and safe to save. | Save draft. |
| **Ready to test** | No | All required data and safety rules validate. | Validate. |
| **Tested** | No | A deterministic synthetic event completed with an inspectable trace. | Run test. |
| **Live** | Yes | A named workflow version may react to actual customer events. | Confirm activation with a final readiness summary. |
| **Paused** | No new triggers | Existing runs have a clear run-policy; new external dispatch stops. | Pause or roll back. |

The application should display this state prominently on Home, Workflows, and Orders. “Save draft” must never have external side effects. “Activate version 4” must make those effects explicit: trigger, agent, number, first-delay policy, test-mode status, and the date/time the release begins accepting events.

### AW-03 — Workflow definitions must be immutable per run

The current engine resolves `customGraph` dynamically for a run. That is convenient for implementation but not safe for workflows with waits and call outcomes. A cart-recovery run can start under one graph, wait, then resume into a graph edited later by the merchant. The run has no persisted definition identity to explain the discrepancy.

Create immutable `workflow_versions` and `workflow_releases` records. A release references one version; a workflow run references the release and version that created it. Store a compact graph snapshot or an immutable version ID in `workflow_runs`, and make resumption use the recorded version. Editing should create a new draft version. Activation should promote exactly one version to a release. Rollback should activate a prior version for **new** runs; it must not rewrite existing runs.

### AW-05 — “Testing” is a setting, not a successful test

The current test-mode step has good safety intent: it makes explicit that some compliance checks remain non-bypassable and automatically expires. Yet it is not a user test. The flow preview, meanwhile, is a useful storyboard and browser-agent call but not an event-to-outcome proof. It does not submit a synthetic Shopify webhook, create a run against an active version, schedule the appropriate call, exercise provider configuration, or record an operation trace.

The product needs one **Test my automation** action immediately after the recommended configuration. It should create a synthetic event and a non-customer test recipient, execute against the draft/release in a safe test namespace, and show a run timeline: event received, trigger matched, compliance result, schedule created, call/agent test outcome, action results, and data written. It should offer a clear statement of what was simulated versus what was actually placed. The existing browser call and storyboard can be reused as components of this path, but they should not be presented as the whole test.

### AW-06, AW-07, and AW-10 — The workflow runtime needs a merchant-readable operational contract

The scheduler and engine contain several strong implementation choices. Shopify events are idempotent. Scheduled calls are claimed atomically. Compliance checks run on the dispatch path. Wait nodes use version-aware updates. The webhook outbox is durable and retryable. These are foundations worth preserving.

The gap is that the merchant sees partial consequences rather than the run. Orders exposes scheduled calls and block reasons; Conversations exposes calls; admin users can inspect workflow runs. A merchant cannot see that an event matched a release, entered a particular node, was delayed, received a provider error, had an SMS failure, or is waiting on an outbox delivery. The runtime also treats extra edges from linear nodes as a warning even though it deterministically uses the first edge.

Introduce a user-facing **Automation activity** view backed by append-only `workflow_run_events` and `workflow_run_actions` tables. Each event should carry a timestamp, release/version ID, node ID, event type, status, durable error code/message, attempt count, and a safe customer reference. Avoid treating `completed` as a blanket success. Distinguish `completed`, `completed_with_action_failures`, `blocked`, `waiting`, `canceled`, and `failed`. Change the validator so ignored graph topology is an error, not a warning: a linear node must have at most one outgoing edge, and a branch node must expose an explicit default.

## 4. Recommended Product Model

### 4.1 The default should be a launch path, not a workflow builder

For Shopify self-service, the first-run experience should begin with one recommended outcome: **Recover abandoned carts**. The merchant sees a plain-language recipe, not a graph:

| Step | Merchant action | System action | Time target |
|---|---|---|---:|
| 1. Connect store | Click “Connect Shopify” and finish OAuth. | Confirm store, region, and webhook health. | 1–2 min, external |
| 2. Choose first outcome | Confirm “Recover abandoned carts.” | Create a draft from the recommended workflow and agent profile. | <30 sec |
| 3. Choose test recipient | Use own phone or invite a teammate. | Prepare safe test event and test-only call context. | <30 sec |
| 4. Prove it | Click “Run test.” | Execute synthetic event → release matching → run trace → browser/phone test. | 1–2 min |
| 5. Make live | Review one concise card and confirm. | Provision/confirm number, activate release, show status. | <1 min after dependencies |

The product may retain business name, number selection, provider configuration, language, and custom workflow logic, but those should come after the user has a known first outcome or only when the selected activation mode requires them. If a number cannot be provisioned instantly, the product should say so before OAuth begins and offer a browser-only verification path.

### 4.2 Separate modes by user intent

The current page tries to serve three modes simultaneously: quick setup, template adjustment, and expert automation authoring. They need distinct locations and terminology.

| Mode | Intended user | Surface | Allowed actions |
|---|---|---|---|
| **Quickstart** | New merchant | Dashboard launch checklist | Select recommended outcome, connect, test, activate. |
| **Automations** | Operator | Outcome cards and activity log | Pause, resume, edit safe parameters, review impact, inspect runs. |
| **Automation studio** | Expert operator or internal success team | Advanced route behind “Customize” | Fork version, edit graph, validate, test, compare diff, release, rollback. |

The current “Build your own with plain language” input and “Start blank” path should be removed from the quickstart surface. It may remain in Automation Studio after a clear warning that custom changes create a draft rather than a live flow. The UI must not use “Save” where the real operation is “Save and activate.”

### 4.3 Offer only self-service-capable verticals

Insurance should not be selectable in a self-service flow until it has an actual template set, input source, event pathway, and test path. Replace the current option with one of two honest models: remove it from onboarding, or label it **“Talk to us—guided pilot”** and route it to a human-assisted activation path. Do not route users into a wizard that can truthfully say “No agent templates available” while blocking continuation.

## 5. Engineering Remediation Plan

### Phase 0 — Stop misleading behaviour (1–3 days)

The immediate objective is to prevent users from believing they safely changed or activated something when they did not.

| Work item | Required change | Acceptance test |
|---|---|---|
| Disable unsupported trigger editing | Hide trigger editing on merchant custom graphs until dispatch reads releases/custom triggers. | No merchant UI control can change a field that runtime ignores. |
| Split draft from activation | Make all current workflow saves persist `enabled: false` or the existing active state unless the user explicitly activates. | Saving a draft cannot create new externally dispatched runs. |
| Stop auto-enabling workflows at the Agents step | Provision recommended workflows as Draft/Ready, not Live. | Reaching Agents creates no dispatchable workflow. |
| Make review real | Replace “Go to dashboard” with “Activate [workflow name]” and a final readiness summary. | Activation produces one auditable state transition. |
| Repair core error recovery | Add Retry to workflow list/detail and preserve any locally edited draft after retry. | A failed workflow query has a keyboard-accessible in-product retry. |
| Gate unsupported verticals | Restrict insurance to a pilot path or add a complete vertical contract first. | No user enters a blocked self-service flow. |

### Phase 1 — Build the five-minute verified-demo path (1–2 weeks)

Create a dedicated activation orchestration layer instead of using onboarding flags as a proxy for readiness. The layer should own an `activation_session` with idempotent steps, prerequisite state, and a user-visible timeline. It should build the recommended workflow draft, track OAuth/number readiness, and run a synthetic test event. It should not rely on the user to navigate among Agents, Workflows, Phone Numbers, Settings, and Orders.

The first version can reuse existing capabilities: recommended defaults, the browser test-call pipeline, graph preview, compliance gates, scheduler, and outbox. The new work is orchestration and truthful status. A test needs a correlation ID that joins the synthetic trigger, `workflow_run`, scheduled action, test-call result, and report. The final card should say exactly what happened and whether any action was simulated.

### Phase 2 — Establish immutable release and run semantics (2–4 weeks)

Add a version/release model:

```text
workflow template
  → workflow version (immutable graph + validation result)
  → workflow release (draft | test-ready | live | paused)
  → workflow run (references release/version snapshot)
  → run events and action outcomes
```

Build a trigger index from live releases. Event dispatch should resolve `{org, event, release}` in one transaction or durable lookup. Store a release/version reference on each run. Use the recorded version during wait resumption and call-outcome continuation. A new release affects only new events.

For workflow nodes, use an action ledger and idempotency keys per run/node/action. Calls, SMS, and webhook enqueue should have separately inspectable outcomes. The outbox can remain asynchronous, but the user-facing run must show that delivery is pending, delivered, retried, or dead-lettered. Retain the existing scheduler’s atomic claims and compliance gates; do not replace those working safety controls with a frontend-only abstraction.

### Phase 3 — Build merchant operations, not just admin diagnostics (3–6 weeks)

Expose a single Automation Activity view to merchants. Every row should answer: **what triggered this, which version ran, current state, what happened last, why it is blocked or failed, and what is safe to do next.** Provide filters by automation, status, release, date, and safe customer identifier. Link the row to relevant conversation and order records while maintaining least-privilege data exposure.

The existing Orders view can remain a commerce-oriented projection. It should link to the automation run rather than serve as the only troubleshooting surface. The admin Workflow Runs page can remain for cross-org support, but it must not be the sole place that can explain a merchant’s own automation.

## 6. Reliability and Safety Considerations

The audit found positive runtime controls: idempotent Shopify ingress, compare-and-swap claims for scheduled calls, DNC and calling-window checks, attempt limits, provider dispatch, agent-enabled gating, and a webhook outbox with backoff/dead-letter state. Preserve these.

The redesign must additionally satisfy the following:

| Concern | Required control |
|---|---|
| Configuration changes during active runs | Immutable workflow versions and per-run version references. |
| Duplicate event and action execution | Existing inbound idempotency plus per-run/node action keys. |
| Compliance before user-visible “live” | Readiness service must confirm number, region, consent/calling-window posture, and agent state before activation. |
| Synthetic testing | A separate test namespace and obvious labels so test events cannot contact a real customer or contaminate production analytics. |
| External dependency outage | In-product retry and durable “blocked/failed with reason” states, not instructions to refresh. |
| Background scheduling topology | Retain atomic claims; add scheduler heartbeat, due-run lag, queue-depth, and dead-letter metrics so a merchant/support agent can tell a workflow delay from a worker outage. |

WCAG 2.2 also supports treating status, focus, and error recovery as release criteria rather than incidental UI details. Dynamic failures and actions should remain perceivable, keyboard-operable, and understandable.[2]

## 7. Launch Metrics and Acceptance Criteria

Do not call the product a five-minute setup experience until these metrics are instrumented and reviewed with real cohort data. The exact targets below are proposed product thresholds, not observed current performance.

| Metric | Proposed success threshold | Instrumentation point |
|---|---:|---|
| Sign-in to synthetic test start | Median ≤ 5 minutes for Shopify trial cohort | `activation_started` → `test_started` |
| Synthetic test completion | ≥ 85% of users who start a test see a terminal trace without support intervention | `test_started` → `test_completed` / `test_failed` |
| Live release clarity | 100% of live releases create one explicit activation event with version, trigger, and readiness summary | `workflow_release_activated` |
| Trigger correctness | 100% of custom trigger edits either change dispatch or are unavailable | Release trigger index tests + runtime integration test |
| Run explainability | 100% of terminal run states expose a merchant-readable reason and last action | Run-event contract tests |
| Workflow error recovery | 100% of primary workflow data-load failures expose Retry | UI integration tests at desktop and mobile widths |
| Unsupported-path prevention | 0 self-service users can select a vertical with no activation contract | Onboarding route tests |

## 8. Final Prioritization

The first release should **not** add more nodes, more AI drafting, more provider controls, or more dashboard tiles. It should make the existing recommended cart-recovery automation trustworthy.

1. **Fix the configuration/runtime contract:** trigger selection, explicit activation, and immutable run versions.
2. **Create a truthful first test:** one synthetic event with a complete, visible trace.
3. **Concentrate the journey:** one launch checklist instead of a modal plus several independent pages.
4. **Make operations explainable:** merchant-visible run history and recoverable errors.
5. **Hide unsupported complexity:** advanced canvas and unsupported verticals belong outside the default path.

If those five changes are implemented, Weeber can credibly position itself as an outcome-led voice automation product. Without them, the interface may look polished, but it will continue to behave like a partially exposed internal workflow system.

## Repository Evidence Consulted

This audit is grounded in `packages/web/src/web/pages/app/login.tsx`, `home.tsx`, and `workflows.tsx`; `components/app/setup-modal.tsx`, `components/app/user-shell.tsx`, `components/canvas/NodeConfigPanel.tsx`, and `components/workflow-preview/FlowPreviewPanel.tsx`; `packages/api/src/app/routes.ts`; `integrations/shopify/routes.ts`; `voice/org-queries.ts`, `vertical-defaults.ts`, `workflows/graph-engine.ts`, `workflows/graph-validation.ts`, `workflows/scheduler.ts`, and `webhooks.ts`; the workflow-run schema; vertical configuration; prior workflow documentation; and the mobile visual snapshots for sign-in, Workflows, Integrations, and Phone Numbers. The audit did not modify product code.

## References

[1]: https://www.nngroup.com/articles/progressive-disclosure/ "Nielsen Norman Group — Progressive Disclosure"

[2]: https://www.w3.org/TR/WCAG22/ "W3C — Web Content Accessibility Guidelines (WCAG) 2.2"
