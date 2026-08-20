# Weeber Pilot-Onboarding Execution Plan

## Shopify and Insurance: Fast, Safe, Observable Pilot Activation

**Plan date:** 20 August 2026  
**Repository baseline reviewed:** remote `main` at `1b5390a0b9489806feb71ac3984faded8936d817`  
**Objective:** Get the first pilot customers through a **verified demo in approximately five minutes**, then make an explicit, compliant live release once their external prerequisites are ready.

> **The decision:** Launch two verticals, but only **one primary automation outcome per vertical** in the first pilot. Do not ask pilot customers to build workflows. They should select an outcome, prove it safely, and deliberately make it live.

| Vertical | First pilot outcome | Why this is the right first outcome |
|---|---|---|
| **Shopify** | Recover abandoned carts | The repository already has the closest event source, agent templates, and workflow foundations for this path. |
| **Insurance** | Follow up with a new lead | The repository already has Insurance lead ingestion, active agent templates, advisor assignment, CRM, transfer/callback tools, and a merchant Leads surface. |

**Policy Renewal Reminder** remains the next Insurance outcome, but it should follow the same release and event-ingestion design after New Lead Follow-Up is proven. This is not a reduction of the two-vertical launch. It is the smallest credible way to make both verticals successful quickly.

## 1. Current State: What Is Already Done

The local audit checkout is ten commits behind remote `main`; the plan below reflects remote `main`, not the older 15 August source snapshot. Keep the untracked audit files separate and work from a fresh branch/worktree based on remote `main` rather than pulling over the current audit workspace.

Several earlier findings are already addressed and should **not** be re-planned:

| Already addressed in remote `main` | Practical effect | Plan impact |
|---|---|---|
| Agents and Workflows now expose an in-product Retry action. | Core data-load failures no longer require a manual browser refresh. | Do not spend pilot time redoing generic error-state work. [2] |
| The mobile waitlist form stacks its email field and CTA; form failures use live announcements. | The public mobile conversion issue is corrected. | Treat it as release verification, not a backlog item. [2] |
| Login/signup moved to the public surface with cross-domain session handoff. | The prior authentication route issue is structurally addressed. | Perform a staging acceptance test; do not redesign auth again. [3] |
| The runtime records actual LLM model/provider, endpoint signal/delay, TTS socket-open time, greeting fast-path hits, and deploy identity. | Voice performance can be attributed more reliably. | Use this in pilot monitoring; do not prioritize a provider switch. [4] |
| Database indexing and call-path/background pool separation were added. | The voice and scheduling baseline is safer under pilot load. | Apply migrations and verify deployment configuration before inviting users. [5] |

The critical gaps remain untouched: workflow save still conflates draft and activation; workflow runs do not bind to immutable configuration versions; custom trigger edits are not selected by inbound dispatch; Insurance has agents and leads but no live workflow-release path; and merchants cannot see a full, intelligible automation run timeline.

## 2. Pilot Product Contract

Do **not** promise “live in five minutes” without qualification. OAuth, outbound-number readiness, lead consent, call-window rules, and licensed-advisor availability are real external constraints.

The product promise for pilots should be:

> **“Verify your first automation in about five minutes. Make it live once your connection, number, and compliance checks are ready.”**

This contract is truthful and gives the user one immediate, measurable success. The test must use a synthetic event and a test recipient or browser call. It must never contact a real customer or pollute production reporting.

### The exact pilot flow

| Step | Shopify pilot | Insurance pilot | Product behaviour |
|---|---|---|---|
| 1. Enter | Sign in and choose **Recover abandoned carts**. | Sign in and choose **Follow up with a new lead**. | The dashboard opens a single launch checklist, not the generic workflow canvas. |
| 2. Connect or provide source | Complete Shopify OAuth. | Send/import one sample lead or enter one test lead. | Explain required production prerequisites before the user reaches a blocker. |
| 3. Configure safety | Choose a test recipient; confirm test mode. | Choose test recipient, advisor/callback target, and required consent/contactability fields. | Store a draft only; no external trigger is yet active. |
| 4. Verify | Run a synthetic checkout-abandoned event. | Run a synthetic `lead_ingested` event. | Display one trace: event received → release matched → compliance result → action outcome. |
| 5. Make live | Confirm number/readiness; activate the release. | Confirm number, consent/state/timezone, and advisor route; activate the release. | One explicit, auditable transition from **Tested** to **Live**. |

The UI should expose only these states: **Draft**, **Ready to test**, **Tested**, **Live**, and **Paused**. Do not show “Save” when the action means “Save and activate.” Do not auto-enable a workflow during the agent-selection step. Do not offer the advanced canvas, AI workflow drafting, or a blank graph during this initial path.

## 3. The Critical Path

The work below is ordered by dependency. The first four items are mandatory before a pilot customer can safely use either vertical.

| Sequence | Work item | Scope | Owner role | Completion condition |
|---:|---|---|---|---|
| 0 | Create a clean implementation branch from remote `main` and deploy the latest migrations/config. | Engineering hygiene | Tech lead / platform | Branch is based on `1b5390a`; migrations `0051` and `0052`, pool environment variables, and public-auth redirect URLs are applied in staging. |
| 1 | Make **Draft ≠ Live**. | Shared workflow runtime + UI | Backend + frontend | Save persists a draft; only an explicit activation endpoint can admit new external events. Existing auto-enablement from setup is removed. |
| 2 | Freeze the configuration used by every run. | Shared workflow runtime | Backend | Each run records a release/version snapshot. Editing a draft cannot alter a waiting or in-progress run. |
| 3 | Build one shared event-to-release dispatcher. | Shared workflow runtime | Backend | Shopify events and Insurance events both resolve an active release by `{org, eventType}` with idempotency. The UI cannot edit a trigger that the dispatcher ignores. |
| 4 | Add the two pilot outcome packs. | Vertical configuration | Backend + product | Shopify Cart Recovery and Insurance Lead Follow-Up have canonical templates, required fields, validation, and release-ready defaults. |
| 5 | Implement the safe **Test my automation** transaction. | Shared onboarding + runtime | Backend + frontend | A synthetic event creates a test-namespaced run and shows a terminal trace without sending a real-customer communication. |
| 6 | Build the single launch checklist and release card. | Pilot onboarding UX | Frontend + product | The user follows the five steps above without navigating among Agents, Workflows, Phone Numbers, Orders, and Settings. |
| 7 | Add minimal merchant run visibility and controls. | Operations UX | Backend + frontend | The customer can view trigger, release, last node/action, status, block/failure reason, and Pause. |
| 8 | Run staging and controlled live acceptance. | Product operations | Engineering + pilot operations | Both verticals complete one synthetic test and one authorized real pilot event under an operator runbook. |

## 4. Minimum Engineering Design

Do not build a full general-purpose automation platform before the pilot. Build the narrowest shared contract that prevents the current functional failures.

### 4.1 Release snapshot

Implement a minimal release model. The names may vary, but the semantics must not.

```text
workflow draft
  → validated version
  → test-ready release
  → live release
  → immutable run snapshot
```

The minimum data required is:

| Record | Required fields for the pilot |
|---|---|
| `workflow_versions` | Organization, template/outcome key, immutable graph/config JSON, validation result, author, timestamp. |
| `workflow_releases` | Organization, version ID, event type, state (`draft`, `test-ready`, `live`, `paused`), activated timestamp, test namespace. |
| `workflow_runs` extension | Release/version ID or immutable configuration snapshot, environment (`test`/`live`), terminal status, durable reason code/message. |
| `workflow_run_events` | Timestamp, node/action, status, safe message, action ID, optional retry/attempt. |

The pilot does not need a sophisticated visual diff interface. It does need a guarantee that a configuration change after a run starts does not rewrite the meaning of that run.

### 4.2 Unified dispatch contract

Route both verticals through one normalized dispatcher:

```text
Shopify webhook ───────┐
                        ├─> normalized event ─> active-release lookup ─> immutable run
Insurance lead/API/CSV ─┘
```

The first supported event types are:

| Vertical | Event type | Pilot payload minimum |
|---|---|---|
| Shopify | `checkout_abandoned` | Checkout/customer reference, E.164 phone if callable, event timestamp, idempotency key, order/cart context. |
| Insurance | `lead_ingested` | Lead reference, E.164 phone, contactability/consent status, timezone/state, interest area when available, advisor/callback target, idempotency key. |

The existing Insurance ingest route is the starting point, but its `triggerWorkflow` note must be replaced with real dispatch through the release model. It must block visibly—not silently—when required contactability, compliance, or advisor data is absent.

### 4.3 Minimal customer-facing activity

Add a compact **Automation Activity** panel before building a large observability suite. Each run needs only five things for the pilot user:

1. **What started it** — checkout or lead event, with a safe reference.
2. **What version ran** — outcome name and release timestamp.
3. **Where it is now** — queued, waiting, action in progress, completed, blocked, failed, or paused.
4. **Why it stopped** — a merchant-readable block/failure reason.
5. **What is safe next** — retry test, correct prerequisite, pause, or contact support.

Orders and Leads can keep their vertical-specific roles. They should link to the run rather than serve as the only explanation of automation behavior.

## 5. Vertical-Specific Pilot Configuration

### Shopify: Abandoned Cart Recovery

The Shopify pilot is ready for onboarding only when OAuth/webhook health, a valid calling number, and the cart-recovery release are ready. The test does not depend on waiting for a real abandoned cart. It should submit a synthetic test event using a test recipient, show the release match, show the compliance decision, and run the existing browser/call-test mechanism as clearly labelled test activity.

**Keep out of the first pilot:** COD confirmation, post-delivery feedback, custom triggers, custom graphs, AI drafting, multi-workflow sequences, and provider comparisons.

### Insurance: New Lead Follow-Up

Insurance should be a launch vertical, but it needs more disciplined preconditions because caller targeting and escalation matter. The first outcome should create a single release from the **Insurance Lead Follow-Up** agent template. It must require a valid test lead, contactability/consent input, timezone/state, and a licensed advisor callback or transfer target. If a number or advisor is not ready, the product can still complete the synthetic browser/test trace; it must not offer Live.

**Keep out of the first pilot:** final-expense qualification, post-sale/claims workflows, automated policy renewal, generalized CRM workflows, and editable regulatory prompt logic. Policy renewal should be the first incremental Insurance outcome after lead follow-up has a successful real run.

## 6. What to Defer

The fastest route is achieved by **not** building the following now:

| Defer until after the first successful pilots | Reason |
|---|---|
| Free-form canvas and blank workflow creation | The current canvas exposes semantics that the dispatcher/runtime does not fully honour. |
| AI workflow drafting in onboarding | It creates variation before the release model and test trace are trustworthy. |
| More workflow nodes, branches, and advanced tool parallelism | The pilot needs one safe result per vertical, not authoring flexibility. |
| Changing the default LLM provider or optimizing cache controls | Recent remote work has improved attribution; use pilot data before changing reliability/latency trade-offs. |
| A broad analytics dashboard | The first operator need is a run trace and a pause control, not aggregate charts. |
| Multiple Insurance outcomes | One proven lead-follow-up path is more valuable than six unverified choices. |

## 7. Pilot Readiness Gates

No customer should be invited until every gate below has passed. These are binary release gates, not aspirational metrics.

| Gate | Required evidence |
|---|---|
| **Authentication** | A staging user completes public signup/sign-in, confirmation if enabled, callback handoff, sign-out, and re-entry into the launch checklist. |
| **Configuration safety** | Saving a draft has no external effect; only explicit activation creates a live release; Paused releases accept no new events. |
| **Run immutability** | Start a test run, edit the draft, and confirm the existing run continues with its recorded version/snapshot. |
| **Shopify test** | Synthetic `checkout_abandoned` reaches a test run, records a trace, and shows an intelligible terminal result. |
| **Insurance test** | Synthetic `lead_ingested` with a test lead reaches a test run, validates the advisor/contactability prerequisites, and shows an intelligible terminal result. |
| **Live protection** | A deliberately missing number, consent/contactability field, advisor route, or calling-window condition is blocked with a visible reason and creates no external call. |
| **Operator control** | A pilot operator can pause a release, find a run, determine why it is blocked/failed, and confirm the active deployment SHA from health/monitoring. |
| **Voice quality** | Test calls record actual model/provider, endpoint signal/delay, TTS socket-open time, and greeting fast-path hit/miss; no model change is approved without these measurements. |
| **Migration/deploy** | Current remote migrations, auth settings, and connection-pool configuration are applied and validated in staging before production pilot traffic. |

## 8. Pilot Operations

Begin with a deliberately small cohort: **two design-partner organizations per vertical**, one active outcome per organization, and a named internal operator. Each pilot customer receives a short onboarding call only for external prerequisites—not for product navigation. The product itself must complete the checklist.

For each organization, capture a one-page launch record: connected system, number readiness, permitted test recipient, consent/contactability evidence, advisor escalation target where applicable, active release/version, operator owner, and pause procedure. This is the practical bridge between a fast onboarding product and the real-world constraints of voice automation.

The first live event for every organization should be observed. Do not scale the cohort until each vertical has completed one authorized live run that is traceable end to end: input event, release, compliance decision, action attempt, outcome, and operator visibility.

## 9. Execution Order for the Team

The immediate working order is:

1. **Sync safely to remote `main` in a new branch/worktree and validate staged auth/migrations.**
2. **Implement release state and immutable run snapshots.** Do not start with UI polish.
3. **Implement the shared dispatcher and wire only Shopify cart recovery plus Insurance lead ingestion.**
4. **Create the safe synthetic test transaction and terminal run trace.**
5. **Build the single launch checklist and explicit “Make live” card.**
6. **Add Pause and minimal Automation Activity.**
7. **Run the readiness gates with internal test organizations, then four design partners.**

Only after this sequence succeeds should the team add Policy Renewal Reminder, custom canvas releases, AI workflow drafting, broader Insurance templates, or model/cache optimization.

## References

[1]: https://github.com/Aurora-091/weeber/commit/1b5390a0b9489806feb71ac3984faded8936d817 "Weeber remote main baseline — 20 August 2026"

[2]: https://github.com/Aurora-091/weeber/commit/f5431e113bae "UI/UX audit fixes: recoverable errors, mobile waitlist, nav sign-in, pricing clarity"

[3]: https://github.com/Aurora-091/weeber/commit/ac83ea989ca0 "Move login/signup to the public surface with a real cross-domain session handoff"

[4]: https://github.com/Aurora-091/weeber/commit/4b723acfd00f "SOTA-fix-marathon Phase 0: make production truth measurable"

[5]: https://github.com/Aurora-091/weeber/commit/1b327a7ad3a0 "ADR-116 addendum: split the DB connection pool for call-path vs. background"
