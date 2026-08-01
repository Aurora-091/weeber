---
adr: 67
title: "One composition path, and an editor that shows what actually ships — compiled prompt, tool consequences, guardrail consequence text"
date: 2026-08-01
status: Accepted
---

## ADR-067 — The agent editor shows what actually ships
**Date:** 2026-08-01

**Context:** `audit/agent-editor-ux-case-study.report/content.md` §4.4/§5.1/§5.2 landed on the same finding
three times from three angles: a merchant editing an agent is making decisions blind.

Concretely, before this change:

- **The prompt was mostly invisible.** A merchant types into one textarea (`personaPrompt`) and the agent
  is sent **five** layers: `buildLanguageInstructionBlock` + `buildIdentityBlock` + their text +
  `withDisclosure`'s appended line + the whole `withCallControl` call-control/boundaries/tone block.
  Four of the five were not surfaced anywhere in the product. Every "why did it say that?" question was
  therefore unanswerable from inside the UI, and the answer to "is my instruction being overridden?" was
  literally unavailable.
- **Two hand-rolled composition sites.** `resolveAgentConfig`'s DB-row branch (`voice/agent.ts`) and
  `buildPreviewAgentConfig` each spelled out the same nested expression by hand. Any panel that rendered
  "the prompt" by re-deriving it in a third place would have been a fourth thing to keep in sync, and the
  first one to silently drift.
- **Tool checkboxes were raw identifiers.** `agents.tsx` rendered `{name}` in `font-mono` —
  `offerCartRecoveryDiscount`, `confirmCodOrder`, `sendDtmf`. The merchant is being asked for a
  permissions decision, phrased as a variable name, with no statement of consequence, and with the tool
  that can irreversibly cancel a real order sitting in the same undifferentiated grid as the one that
  tags a call's intent.
- **Guardrail dials had no consequence text.** Three `<select>`s of `low / medium / high` with no help
  text at all. Nothing in the UI said what changes. A merchant can only set these by superstition.

A latent honesty problem sat underneath the third point: **`injectionSensitivity` does not affect the
runtime injection detector.** The detector (G1.5, `voice/injection.ts`) runs identically at all three
levels; the dial only rewrites one prompt sentence. Anyone reading "high" as "stricter detection" is
wrong today.

And a fidelity bug the panel would have exposed on day one: `buildPreviewAgentConfig` never fetched
`orgs.name`, so **every previewed prompt was missing the "You are calling on behalf of X" line that the
real call ships** (`resolveAgentConfig` fetches it; the preview did not).

**Decision:** three changes, one principle — *the editor shows the thing that actually ships, sourced from
the code that actually ships it.*

**1. One composition path (D2, backend).** New `composeSystemPrompt()` in `voice/agent.ts` returns both
the final string **and** the labelled layers it is made of:

```ts
{ text: string, segments: Array<{ id, label, source, body, editable }> }
```

`withCallControl` was split so its tail is available on its own (`buildCallControlBlock`), and both
`resolveAgentConfig`'s DB-row branch and `buildPreviewAgentConfig` now call `composeSystemPrompt` instead
of re-spelling the expression. The layers are carried on `ResolvedAgentConfig.promptSegments` and returned
by two new pure endpoints (`POST …/agent-configs/:templateKey/compiled-prompt`, merchant and admin). The
UI never assembles prompt text.

The load-bearing guarantee is a unit test, not a convention:
`segments.map(s => s.body).join("") === text`, byte for byte, including the empty-config case. A future
layer added to composition but not to `segments` fails there first.

`buildPreviewAgentConfig` takes an optional `orgId` and resolves the merchant name, closing the preview
fidelity gap. Every call site (test-chat, test-call-token, test-call-phone, synthetic test, the WS test
call) now passes it, so a preview and a live call compose identically.

**2. Consequence over label (D4, tools).** `TOOL_EDITOR_META` in `packages/web/src/web/lib/agent-config.ts`
gives every tool a human label, a one-line description, and a **consequence group**, and the merchant
editor renders those grouped as *Conversation control* · *Data capture* · *Acts outside the call*. The
third group carries visual weight (warning-toned border when enabled) because those five tools spend
money, message a customer, create a booking, or change an order state. The raw identifier stays reachable
as the `title` attribute — it is what appears in call logs and API payloads, so hiding it outright would
break the trail from the editor to the timeline.

Deliberately **separate from `TOOL_LABELS`**, which is past-tense call-timeline copy ("Ended call") and
reads as nonsense on a checkbox granting a capability ahead of time.

**3. The resulting sentence, live (D3, guardrails).** The exact instruction line each dial injects is
rendered under the control, in mono, updating as the control changes. The strings moved to a
dependency-free `voice/prompt-lines.ts` (`TOPIC_BOUNDARY_LINES`, `INJECTION_LINES`, `abuseHandlingLine()`),
which `withCallControl` now imports — so there is one authoring site — and the web copy is guarded by a
parity test that cross-imports that module (same pattern as `AVAILABLE_TOOL_NAMES`).

The abuse sentence has two "enabled" variants depending on whether `flagGuardrailEvent` is on; the panel
reflects that, which makes a real hidden coupling visible: *unticking a tool changes a guardrail's
wording.*

And the `injectionSensitivity` dial carries an explicit note that it changes prompt wording only and does
**not** change the always-on runtime detector. Stating the limitation is cheaper than a merchant
discovering it during an incident.

**Rejected alternatives:**

| Alternative | Why rejected |
| --- | --- |
| Render the compiled prompt in the web package by re-implementing composition | The exact failure the panel exists to prevent. Two composers drift, and the one that drifts is the one nobody tests against a live call. Composition stays in `voice/agent.ts`; the UI receives layers. |
| Dump the whole prompt as one `<pre>` block | Answers "what is sent" but not "which part is mine", which is the actual question. A 4,000-character wall with the merchant's 300 characters buried at position ~600 is technically transparent and practically useless. |
| Tooltips / help icons on the guardrail dials | A tooltip is a claim *about* the setting. The sentence is the setting. Rendering the real text costs the same space and cannot go stale, because the parity test fails the build if it does. |
| A modal instead of a drawer tab | The value is comparing the prompt against the form while editing. A modal hides the form. The Preview drawer already sits beside the editor and already carries "this tests your unsaved edits". |
| Word-level diff on change | The call-control block is a bulleted list; a character-level smear across reflowed bullets is noise. Line-level shows "this bullet appeared / that one left", which is what a tool toggle actually does. |
| Make `injectionSensitivity` actually drive the runtime detector | A real improvement, and out of scope here — it changes call-time safety behaviour and needs its own evidence (what does "low" mean for a detector whose false-negative cost is a hijacked call?). Documenting today's truth is the honest interim. Tracked as open. |
| Also rebuild the admin dashboard's tool checkboxes | Admin is an internal ops surface where the raw identifier is the useful string. The compiled-prompt tab is shared (both pages pass `compiledPromptFetchFn`); the merchant-facing chip and guardrail copy is not. |

**Consequences:**

- `composeSystemPrompt` is now the only place a system prompt is assembled from parts. The bare
  `resolvePersona` fallback paths (no org config row) leave `promptSegments` undefined rather than fake a
  segmentation they didn't produce — the endpoint returns `segments: []` there, and the panel renders
  nothing rather than something wrong.
- The panel shows the **configured** prompt only. `buildKnownFactsBlock`, `buildWorkflowContextBlock` and
  `buildCallerMemoryBlock` are appended per call from live state and are named in the panel's footer
  instead of being faked ahead of a call.
- `prompt-lines.ts` is now load-bearing for two packages. It must stay dependency-free (one type-only
  import) so the web parity test can pull it in without dragging server runtime into a browser test.
- The preview now hits the DB for the org name on every compile. Mitigated by a 400ms debounce in the
  panel; the endpoint does no LLM and no telephony work.
- `D1` (create-agent), `D5` (prompt versioning) and Phase IV (eval/judge) remain out of scope and
  unstarted.
- Verified: api `tsc` ✓ · web `tsc` ✓ · `bun test --isolate src/` in `packages/api` **839 pass / 0 fail**
  (+9: the composition-invariant suite) · `bun test --isolate src/` in `packages/web` **42 pass / 0 fail**
  (+8 panel component tests, +8 tool/guardrail parity tests) · `oxlint` 0 warnings / 0 errors.
- **Not verified at the time of writing:** the merchant editor's Tools & Guardrails tab is typechecked and
  lint-clean but has no render test, and nothing here had been seen in a running browser — no dev server
  was booted. First visual pass should check the three tool groups and the mono consequence lines against
  `UI-DESIGN-BRIEF.md` (12px radius, monochrome accent, JetBrains Mono reserved for technical strings).

**Confirmed 2026-08-01 (same day, after the browser pass).** The visual pass above was done through a
DEV-only `phase3` page in `pages/__preview.tsx` mounting `ToolsGuardrailsTab` beside `CompiledPromptPanel`
with local state (web-only Vite server, no API, no telephony). The three groups, the mono consequence
lines, the layer badges and the line-level diff-on-toggle all render as designed, light and dark, zero
console errors.

The decision paid for itself on that first render. Displaying the call-control layer as a human reads it
exposed that `buildCallControlBlock` had been shipping **ragged indentation into every live call since the
block was written** — ``dedent`…` `` computes its minimum indent *after* interpolation, and the multi-line
constants it interpolates are flush-left, so nothing was ever stripped. No unit test could have caught it;
839 of them didn't. Fixed the same day (flush-left `string[]` + `join("\n")`, content unchanged, plus a
`/^ {3,}/` regression test). A second, smaller defect fell out of the same pass: the "no caller ID" banner
hardcoded dark-mode-only `amber-*` values and was unreadable in light mode.

The general lesson, worth carrying into future phases: *rendering an artefact for a human to read is a
distinct verification class from asserting on it in a test.* Both defects were type-correct, lint-clean
and fully covered by passing tests.
