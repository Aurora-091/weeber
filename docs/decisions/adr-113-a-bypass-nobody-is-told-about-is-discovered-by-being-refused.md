# ADR-113 — A bypass nobody is told about is discovered by being refused

- **Date:** 2026-08-13
- **Status:** Accepted (implemented 2026-08-13; UI + one onboarding step key)

## Context

ADR-108 diagnosed a founder's "dialing `+91` stopped working" as nothing being broken: the
insurance 1600-series gate is unconditional for that vertical, no org holds such a number, and the
escape hatch — `orgs.calling_window_test_mode_until`, armed by
`POST /api/app/compliance/test-mode` for 24 hours — had simply lapsed. That ADR fixed the
*legibility of the expiry*: a refusal now names the lapsed window, and Home and Settings carry a
countdown.

It did not fix the first-contact version of the same problem. Test mode lives on the **Settings**
page, one toggle among account, compliance and advisor sections, and onboarding never mentions it.
So the sequence for a new org is: finish setup, enable an agent, place the first call, get refused
with a paragraph about TRAI registration — and only then go looking. The remedy exists before the
failure and is invisible until after it. For a product whose entire launch motion is founder-run
demos, the first call being refused is the demo.

`orgs.calling_window_test_mode_until` is NULL on every fresh signup and neither org-insert path
writes it, so this is the shipping default, not an edge case — the same shape as ADR-111's
`human_transfer_number`.

## Decision

**A fifth onboarding step: "Are you testing first, or calling real customers?", between the phone
number step and review.**

- **No new endpoint.** `POST /api/app/compliance/test-mode` already does exactly this, already
  clamps to `now() + 24h` server-side rather than accepting a duration from the client, and is
  already the Settings toggle's path. The capability was never missing; only its discoverability
  was. A second route would be a second place for the 24h clamp to drift.
- **"These are real customers" is a complete answer, not a skip.** Both answers advance. The step
  is a question with two defensible answers, and modelling one of them as a skip would make the
  compliant choice feel like the incomplete one.
- **The persisted flag is `test_mode_choice` — the answer, not the state.** It cannot be derived
  from `calling_window_test_mode_until`, because "real customers" correctly leaves that column
  NULL, which is indistinguishable from never having been asked. Added to `ONBOARDING_STEP_KEYS`,
  which is a free-form jsonb bag and needs no migration.
- **When "no" writes, and when it does not** — `shouldPostTestMode` in
  `web/lib/test-mode-onboarding.ts`. "Yes" always posts; that is what arms the window. "No" posts
  **only when a window is currently active**, which is a revocation the merchant just asked for. It
  does **not** post for a never-configured org (a write that changes nothing, firing on every
  signup) and does **not** post for an already-**expired** timestamp, because clearing it would
  erase the only evidence ADR-108's lapsed-window hint reads to explain a refusal. Distinguishing
  expired from never-configured is therefore load-bearing, not cosmetic.
- **The step is recorded only after the write it depends on succeeds.** Marking the step done on a
  failed POST would leave an org believing it is in test mode when the next call will be refused —
  which is the exact failure this ADR is about, re-created one layer up.
- **The copy names what test mode does not lift.** Do-not-call and the repeat-attempt cap apply in
  every mode with no override — they are deliberately absent from ADR-108's `TEST_MODE_BYPASSABLE`,
  and a merchant who reads "compliance off" and then dials a scrubbed list has been misled by us.
  `summarizeTestMode` is asserted never to say "compliance off" and always to name DNC while the
  window is active.

**The decision logic lives in a pure module, not in the click handler**, on ADR-111's precedent:
the rule about when an answer may write is the only part worth asserting, and a rule buried in an
800-line modal is a rule no test reaches.

## Rejected

- **A "skip" affordance.** See above — it makes the compliant answer look unfinished.
- **Asking for a duration, or making 24h configurable.** ADR-108: the window *is* the control.
- **Defaulting the answer from `orgs.vertical`** (insurance → probably demoing). It would arm a
  compliance bypass from an inference, which is precisely what ADR-110 refused to do with market.
- **Deriving step completion from `calling_window_test_mode_until`.** Conflates "answered no" with
  "never asked".
- **Posting `enabled: false` unconditionally on "no".** A no-op write on every signup, and it
  destroys ADR-108's diagnostic evidence when the column holds a lapsed timestamp.
- **Relaxing the India insurance 1600-series gate instead.** Explicitly out of scope and refused:
  that gate is the mechanism enforcing "insurance is US-only", and test mode is the sanctioned,
  self-expiring way around it for a demo.

## Consequences

- web tests **85 → 95** (10 in `test-mode-onboarding.test.ts`), non-vacuity proven by making
  `shouldPostTestMode` always return true (2 of 10 fail). All six ratchets green, nothing widened
  (`design:guard` 581, `rawButton` 111 — the two choice cards use the `Button` component, not the
  raw `<button>` the vertical step uses).
- Verified by driving the built harness (`/__harness/app-home`) with fulfilled API responses:
  the checklist reads "Up next: Choose testing or live calling", the modal opens on the new step 5
  of 6, "Turn on test mode" posts exactly `{"enabled":true}` and then patches exactly
  `{"steps":{"test_mode_choice":true}}`, and the review step gains a "Test mode:" row. No visual
  baseline covers the setup modal, so this is the verification, not a snapshot.
- `ONBOARDING_STEP_KEYS` gaining a member means `updateOnboardingState` computes `allDone = false`
  for any pre-existing org whose bag lacks the key, so a previously-completed org would have
  `completed_at` nulled on its next patch. Production holds **0 orgs**, so this affects nothing
  today; it is recorded because it would matter if the key set changed again after real signups.

## Known and unfixed

- Test mode remains a **blanket** 24h lift for every destination, not a demo-scoped one. ADR-108
  recorded that the FCC's Feb-2024 AI-voice ruling puts TCPA statutory damages ($500–$1,500 per
  call, no aggregate cap, private right of action) on the platform, and nothing in the product
  distinguishes "calling my own phone" from cold outreach. Asking the question makes the choice
  explicit; it does not make the bypass narrower.
- Onboarding still never asks for `orgs.human_transfer_number` (ADR-105/-111), so the fresh org
  that dead-ends a qualified lead is still the org we ship.
