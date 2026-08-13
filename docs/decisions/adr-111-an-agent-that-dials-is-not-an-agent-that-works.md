# ADR-111 — An agent that dials is not an agent that works

- **Date:** 2026-08-13
- **Status:** Accepted (implemented 2026-08-13, UI-only)

## Context

`classifyReadiness` (added 2026-08-01 with the agents overview grid) answered one question —
*"is this agent actually going to work?"* — from exactly two booleans: `enabled` and
`hasCallerId`. Three states came out: `paused`, `needs-number`, `live`.

That model was built for one failure: an agent toggled on with no caller ID, which cannot dial at
all. It is the right first question. It is not the only one, and since ADR-105 shipped it has been
demonstrably the wrong last one.

ADR-105 made the backend **narrow the tool set at call time**: when the org has no
`orgs.human_transfer_number`, `narrowToolsForTransferCapability` drops `transferToHuman` out of
`enabledToolsOverride`, which rewrites the prompt for free through `buildCallControlBlock`. That
was the correct fix for production call 25, where the agent qualified a lead cleanly and closed
with *"You're connected — the advisor will take great care of you"* to a caller who was then hung
up on. The fix stopped the agent from **promising** a handover it could not perform.

Nothing was fixed about the merchant's view of it. On the agents grid that agent rendered a green
**Live** pill, because `enabled` was true and a caller ID existed. Both facts were true. The agent
dialled, talked, qualified, and then had nowhere to send the lead — and the only signal anywhere
in the product was a `console.warn` on a server the merchant cannot read. ADR-105's own
*Known and unfixed* line said exactly this: *"nothing yet tells an operator to set the number
beyond a `console.warn`."*

This is not a rare shape. `orgs.human_transfer_number` was **NULL on 4 of 4 production orgs** as
of 2026-08-12, the DB has since been wiped (0 orgs, 0 users), and neither org-insert path writes
that column — so the **first real signup lands in this state**, with agents whose default tool
list includes `transferToHuman` (`config` is null until the merchant saves once, and both
`toFormState` and the card default to the full `AVAILABLE_TOOL_NAMES`). The degraded state is not
an edge case being defended against; it is the shipping default.

Second, smaller finding, found while reading the same file: **the two surfaces already
disagreed.** The detail page's header pill was hand-rolled — `form.enabled ? "Live" : "Paused"` on
raw `emerald-500/15` / `zinc-500/15` values — so an agent with no caller ID showed a green
**Live** pill in the header while the banner *directly underneath it* said "Live, but no phone
number to call from" and the grid pill said "Needs a number". The shared classifier existed
specifically to stop the two surfaces drifting, and the header was never wired to it. The raw
colour values were also a `design:guard` violation of the same class the banner's own
`text-amber-200/90` was (fixed 2026-08-01, invisible in light mode).

## Decision

**A fourth readiness state, `degraded`, for an agent that dials but has had a capability silently
removed from underneath it.** Label: **"Live · limited"**.

Precedence is `paused` → `needs-number` → `degraded` → `live`: always report the gap that bites
first. A paused agent is not "limited", it is off; and an agent that cannot dial at all should not
be described by what it cannot do *during* a call it will never place.

Three properties of the implementation are load-bearing:

1. **The capability context is a required argument, not an optional one.**
   `classifyReadiness(enabled, hasCallerId, caps)` where
   `caps = { transferToHumanEnabled, hasHumanTransferNumber }`. An optional bag would default to
   "no gaps known", which is precisely how the next surface to render an agent would quietly go
   back to painting a narrowed agent green. Every caller must state what it knows. This is the
   same reasoning as ADR-105's `enabledTools === undefined` handling: the default case is where
   the bug lives, so make it impossible to fall into by accident.

2. **`detail` moves into the classifier.** The card previously hardcoded its own sentence for
   `needs-number` while the banner wrote a different one. One merchant-readable line now comes
   out of the classifier and both surfaces render it; the *affordance* (which tab, which link)
   stays with each surface, because that is genuinely per-surface.

3. **The detail header pill now renders `readiness.label` / `readiness.pillCls`.** The
   hand-rolled two-state pill and its raw `emerald-*`/`zinc-*` values are gone, and the paused
   banner's `zinc-500/20` moves to `border-border/60 bg-muted/40`. The header, the banner and the
   grid pill are now three renderings of one verdict, which is what the extraction was for.

The detail page classifies from **`form.toolsEnabled`**, not the saved row: tick "transfer to a
human" on the Tools tab and the warning appears before you save, not after the first call
dead-ends.

Cost: **zero extra requests.** `orgs.human_transfer_number` is already on `me.org`, loaded by the
shell for every page.

### Scope, deliberately

Three ADRs each describe a capability that is silently narrowed or lapsed on a fresh org today.
Only one feeds the classifier:

| Gap | In this ADR? | Why |
| --- | --- | --- |
| `orgs.human_transfer_number` NULL → `transferToHuman` dropped (ADR-105) | **Yes** | Per-agent, already in `me.org`, and it kills the launch vertical's only conversion event |
| `insurance_advisors` empty → producer licensing allow-and-warn (ADR-098) | No | Org-wide and vertical-scoped, needs a read this page does not make, and it does not narrow *this* agent — the call still places |
| `callingWindowTestModeUntil` lapsed (ADR-108) | No | Already surfaced with a live countdown on Home and in Settings; a second, vaguer copy on the agent card would be noise |

A pill that means "one of three unrelated things is wrong" is not actionable, and "limited" would
stop carrying information the moment it meant three things. Each further gap should earn its way
in with its own reason string, or not go in.

## Rejected

- **Folding it into `needs-number`.** They are opposite failures: one agent cannot start a call,
  the other completes one and fails at the end. Merging them would put "buy a phone number" and
  "set a transfer number" behind the same words, and the fix for each is on a different page.
- **A new semantic colour set for `degraded`.** `.theme-weeber` ships `success`/`warning`/`error`
  and no `info`. Inventing one would add a token pair the contrast gate has never measured, in a
  repo carrying **9 declared contrast failures already**. Reusing `warning-soft`/`warning` adds
  **no new colour combination** and is honest: both states mean "you need to do something". The
  label carries the difference, and a test asserts `degraded` never carries the `success` tokens.
- **Widening `design:guard` for one more raw `<button>`.** The first draft of the banner linked
  "Transfer to a human" to the Tools tab with a raw `<button>`, taking `rawButton` 111 → 112 and
  turning the gate red. Baselines are never widened to go green (repo invariant), so the sentence
  names the tab in plain text instead and the metric is back at 111 with 581 total violations
  unchanged. A tab-jump affordance is worth having; it is worth having as a `ui/button`, later,
  as part of paying that metric down — not as a fresh violation smuggled in under a UI fix.
- **A toast or modal at call time.** The narrowing happens on the server, per call, with no
  merchant watching. The place to say "this agent cannot hand anyone over" is the screen where
  they configure the agent, before the call.
- **Auto-disabling `transferToHuman` when no transfer number exists.** ADR-105 already does the
  runtime-safe thing. Silently rewriting the merchant's saved config would destroy the intent
  they expressed — they want transfers; they are missing one field — and the moment they set the
  number the tool should be back on without them noticing it was ever removed.
- **Blocking save, or blocking the toggle.** This is a warning, not an error. The agent works;
  one path out of it does not.
- **Putting the rule on the server as a readiness endpoint.** Tempting, and premature: every
  input is already in the client's hands. The moment a gap needs a query this page does not make
  (the advisor roster, telephony provider capability) that trade flips — noted, not acted on.

## Consequences

- `agents-readiness.test.ts` 12 → 19 tests, 33 `expect()` calls. New coverage: precedence
  (`needs-number` outranks `degraded`, `paused` outranks both), the fresh-org shape
  (`agentReadiness(row(null), true, false)` → `degraded`), `agentUsesTransferToHuman`'s
  never-saved default (`true` — getting this backwards would hide the gap on exactly the orgs
  that have it) and its empty-list case (`[]` means no tools, not all tools), and that only
  `live` carries the success tokens.
- Non-vacuity proven: stubbing the degraded branch to `false &&` fails **4 of 19** — the four
  tests that assert the state, its label, its `detail` and its non-green tokens.
- All gates green without widening anything: web tests 85 pass, `bunx tsc --noEmit` clean,
  `lint` 0 warnings / 0 errors on 500 files, `design:guard` 581 (no regression),
  `contrast:gate` 33/42 with 9 of 9 declared, `knip:gate` baseline 61, `persona:gate` OK.
- Visual baselines **unchanged and unhelpful**: the harness renders `app-agents` in its *empty*
  state (no per-page query seeds), so the three `app-agents` snapshots still pass and protect
  none of this. Verified instead by driving the built harness with fulfilled
  `/api/app/agent-configs` and `/api/app/telephony/status` responses in both themes and reading
  the screenshots — a populated grid showing one **Live · limited** card with its reason line,
  one **Live**, one **Paused**, and the counts strip reading "1 live · 1 paused · 1 can't
  transfer to a human — set a transfer number". Seeding the harness so this state has a real
  baseline is the follow-up.
- The grid's counts strip no longer folds degraded agents into the green `live` number. It
  previously reported the same reassuring count in this state that it did in a healthy one.

## Known and unfixed

- **Provider capability is invisible to the UI.** `resolveTransferCapability` refuses for three
  reasons — `no-org`, `no-transfer-number`, `provider-unsupported` (only `twilio` and `plivo`
  have a wired mid-call transfer path) — and this state only models the second. An org on
  Exotel with a transfer number set will render **Live** and still cannot transfer. That needs a
  provider read this page does not make, and it is the strongest argument for eventually moving
  readiness server-side.
- Readiness still says nothing about whether an agent has ever placed a call, which is the
  question a merchant actually asks on day one.
- The transfer-number field lives in Settings under "Human Transfer" and nothing in onboarding
  requires it, so the fresh org that ADR-105 was written about is still the fresh org we ship.
  This ADR makes that visible; it does not make it stop happening.
- `orgs.vertical` remains unconstrained and defaults to `"shopify"` on both insert paths
  (ADR-110), so a fresh signup's agent set — and therefore which agents show this state — is
  decided by a column default.
