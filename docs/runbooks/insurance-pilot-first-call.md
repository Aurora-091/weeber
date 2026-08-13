# Runbook — fresh insurance-vertical org to first real call

**Last verified against code:** 2026-08-13, ADR-112 (Step 5 rewritten — the
platform now owns no phone numbers).
**Status of the path itself:** never completed end-to-end. No insurance call has
ever run on this platform. Every step below is read from code and schema, not
from a passing call. Treat the first run as the test of this runbook, not as a
demo.

**Precondition, verified 2026-08-13:** `orgs` is empty (0 rows) and
`org_phone_numbers` is empty (0 rows) in production. There is no existing org to
inherit anything from — every default below is the true cold-start default.

---

## Step 0 — know what the platform will hand you

Read this before touching the dashboard. Four of the steps below exist only
because of a known unfixed gap, and skipping one produces a failure that looks
like a product bug mid-call.

| Fact | Consequence | Source |
| --- | --- | --- |
| `RECOMMENDED_DEFAULTS.insurance = { agents: [], workflows: [] }` | A new insurance org finishes onboarding with **zero** enabled agents. Shopify auto-enables two; insurance auto-enables none. Nothing will ever dial until you enable one by hand. | `packages/api/src/voice/vertical-defaults.ts` |
| `orgs.human_transfer_number` is NULL on a new org and the setup wizard never asks for it | ADR-105 strips `transferToHuman` from the tool list for the whole call. 5 of 6 insurance templates ship that tool, and ADR-081 makes warm transfer the agent's **only** terminal action. The agent qualifies a lead and then has nowhere to send it. | `voice/handoff.ts`, ADR-105 |
| `bookAppointment` is registered unconditionally — no capability narrowing | With no `google_calendar` integration it returns `"(not configured) No Google Calendar connected…"` **to the model, mid-call**, on the exact turn that matters. Unlike `transferToHuman`, nothing removes it first. | `voice/agent.ts:1023`, `voice/tools/bookAppointment.ts` |
| `insurance_advisors` is empty | ADR-098: the producer-licensing gate **allows and warns**. A real US solicitation goes out with licensing unverified. Accepted, logged, greppable as `producer licensing NOT verified`. | `voice/compliance/insurance-gates.ts` |
| Insurance-vertical → `+91` is blocked outright | `checkInsuranceNumberSeriesCompliance` requires an active TRAI **1600-series** number on the org. There is none, and there is no plan to get one. India is not an insurance market. See "India is closed" below. | `voice/compliance/insurance-gates.ts` |
| TTS is single-sourced on Cartesia | ElevenLabs is hard-blocked (`payment_issue`). A Cartesia outage during the call is indistinguishable from a product failure. | provider config |
| `flagGuardrailEvent` false-positives | Present in all six insurance templates. Fired 6x and 4x on *polite* callers in the pre-wipe test corpus. Not yet filed as a defect. Expect noise in the guardrail log; do not read it as caller hostility. | pre-wipe call corpus |

---

## Step 1 — create the org

1. Fresh signup.
2. Setup wizard → vertical **insurance**.
3. Confirm the vertical step so `onboarding.steps.pick_vertical` persists.

**Verify:** `select id, vertical from orgs;` returns exactly your new org with
`vertical = 'insurance'`.

---

## Step 2 — set the human transfer number (do this before anything else)

Settings → transfer number. Must be valid E.164 (`+15551234567`); the API
rejects anything else with a 400.

Use a phone **you will personally answer**. The point of the first call is to
observe the handoff, and a transfer to a number nobody picks up teaches you
nothing about whether the transfer worked.

**Verify two ways:**
- `select human_transfer_number from orgs;` is non-NULL.
- The Agents page card shows **Live**, not **Live · limited**. Per ADR-111, a
  `degraded` / "can't transfer to a human — set a transfer number" pill means
  this step did not take, and the agent will run the whole call without the
  transfer tool.

---

## Step 3 — enable exactly one agent

Pick one. Do not enable all six for a first call — six templates means six
prompt surfaces and you will not know which one produced the behaviour you saw.

- `insurance-final-expense-qualifier` — the sharpest test of ADR-081 (it must
  refuse to quote and hand off instead).
- `insurance-appointment-setter` — use only if you are doing Step 4a.

**Verify:** `select template_key, enabled from org_agent_configs where org_id = '<id>';`

---

## Step 4 — decide what to do about `bookAppointment`

Choose one. Not deciding means choosing the broken path.

**4a — connect Google Calendar.** Settings → Integrations → Google Calendar.
Then `bookAppointment` actually books.

**4b — turn `bookAppointment` off on the agent** (recommended for a first
call). Edit the agent's enabled tools and remove it. The agent then has one
terminal action, warm transfer, which is what ADR-081 says it should have
anyway. Affects `insurance-appointment-setter`,
`insurance-final-expense-qualifier` and `insurance-lead-followup` — all three
carry the tool in `default_tools`.

**Verify:** the agent editor's tool list either has Calendar connected or does
not list `bookAppointment`.

---

## Step 5 — caller ID (the org must supply one)

**Rewritten 2026-08-13.** The platform now owns **zero** phone numbers. Every
Twilio number was released on the founder's instruction: the parent account and
both live sub-accounts hold none, and nothing bills monthly. There is no
platform default caller ID any more.

`resolveOutboundRouting`'s chain is unchanged:

1. `org_agent_configs.phone_number_id` (per-agent assignment)
2. the org's oldest active `org_phone_numbers` row (per-org; `asc(id)` since
   ADR-112 — it used to be an unordered `limit(1)`)
3. legacy `orgs.outbound_number`
4. `TWILIO_PHONE_NUMBER` env default

**Step 4 is now a trap, not a fallback.** `TWILIO_PHONE_NUMBER` on Railway still
names the released number `+19129551304`, so any org that reaches step 4 will
hand Twilio a `from` it does not own and the dial fails at the provider with an
unhelpful error. The var is deliberately untouched (all Railway work is paused),
so the runbook's job is to make sure you never reach step 4.

So the org must have its own number before the first call. Two ways, both
offered by onboarding's `PhoneNumberStep`:

- **Bring your own** — enter Twilio/Plivo/Exotel credentials plus the number.
  Since ADR-112 this also writes an `org_phone_numbers` row with
  `source = 'byo'`, which is what makes the number visible on the Numbers page,
  assignable per agent, and eligible for `numberSeries`. **Requires migration
  `0049_daffy_beyonder.sql` to have been applied** — until then the insert
  fails on the missing `source` column.
- **Auto-provision** — `buyNumberForOrg` rents a number into the org's own
  sub-account (`source = 'purchased'`, billed monthly to the platform).

Verify before dialing: the org has at least one `org_phone_numbers` row with
`status = 'active'`, and `resolveOutboundRouting` therefore stops at step 1 or 2.

---

## Step 6 — dial a US number

Call a **US** number. Non-negotiable for insurance: see "India is closed".

What runs, in order, at `assertOutboundCallAllowed`:

1. **DNC** — no bypass, ever, in any environment. Make sure your test number is
   not on the list: `select * from do_not_call where phone_number = '<num>';`
2. **Calling window** — US TCPA hours are local to the *callee*. From India this
   is the step most likely to refuse you: 8am–9pm ET is roughly 5:30pm–6:30am
   IST. Either call in that window or use test mode (Step 7).
3. **FTSA attempt cap** — never bypassed. A first call to a fresh number passes.
4. Insurance number-series — no-op for a `+1` destination.
5. **Producer licensing** — allows and warns (ADR-098). Expect the warning line
   in logs. Its presence is correct; its absence would mean the area code did
   not resolve to a state.
6. India DLT series — no-op for insurance.

---

## Step 7 — test mode, only if a gate refuses you

`POST /api/app/compliance/test-mode` sets
`orgs.calling_window_test_mode_until = now() + 24h`. Self-expiring by design.

It lifts exactly three gates: the calling window, and the two insurance
*configuration* gates (number series, producer licensing). It does **not** lift
DNC or the FTSA attempt cap — a refusal from either is never a test-mode
problem and must not be described to anyone as one.

Known gap: the ADR-108 countdown surfaced on Home and Settings **does not
tick**. Re-read the page to see the real remaining time, and expect a lapsed
window to look exactly like "this org was never configured" (the gate appends a
diagnosis to the refusal reason to soften this, but the reason text is still the
full regulatory paragraph).

---

## Step 8 — after the call, check these before believing anything

- `select * from calls order by started_at desc limit 1;` — note there is no
  `created_at`, no `ended_reason`, no `duration` column.
- Transcript: `transcripts` roles are `agent` / `caller`, and the text column is
  **not** `content`.
- Did the agent attempt `transferToHuman`? If the tool is absent from the tool
  calls entirely, Step 2 did not take.
- Grep for `producer licensing NOT verified` — expected once.
- Grep guardrail events and discount how many fired on a cooperative caller.
- ADR-081 audit of the transcript: did it ever quote a premium, name a carrier,
  claim licensure, itemize a health condition, or take a DOB/SSN/routing
  number? Any single one of these is a stop-everything finding, not a tuning
  note.

---

## India is closed for insurance (2026-08-13)

The India-side insurance path is deliberately shut and stays shut:

- India is **not** an insurance market for this product. ADR-110 already records
  the insurance templates as authored for the **US** (the final-expense persona
  is explicitly US-only).
- `checkInsuranceNumberSeriesCompliance` is therefore **not a bug to remove** —
  it is the mechanism that enforces this policy. It blocks insurance → `+91`
  unless the org holds a TRAI 1600-series number, and no such number exists or
  is planned. Deleting the gate would *open* India insurance dialing with no
  IRDAI-mandated number, which is the opposite of the intent.
- The one soft edge: test mode (Step 7) currently lifts this gate, so a founder
  in test mode *can* dial `+91` from an insurance org. That is a residual hole
  in a policy that is otherwise closed. Hardening it — making insurance → `+91`
  refuse unconditionally, with no test-mode bypass — is an open decision, not
  yet an ADR.

Shopify is unaffected and keeps both markets: `checkIndiaNumberSeriesCompliance`
covers Shopify → India (flag-gated, off by default), and Shopify → US hits no
vertical gate at all. Note that ADR-110's `AUTHORED_MARKET_BY_VERTICAL` maps
`shopify: "india"`, so a Shopify → US call emits a market-misalignment warning.
That warning is **telemetry only** — it never blocks — but it will be noisy if
Shopify US becomes a real path.
