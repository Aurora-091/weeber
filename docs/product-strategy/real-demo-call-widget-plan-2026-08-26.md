# Real demo-call widget — plan

Status: **Planning only, nothing built.** Written 2026-08-26 at the user's request ("plan for this
thoroughly... what you think of this"). Grounded in this session's own fork audits of the existing
codebase, not assumed.

## What's being proposed

A widget on the public weeber.ai landing page: a visitor enters their phone number, picks a language,
picks one of three demo agents, checks a terms/consent box, clicks "call me" — and a real outbound
PSTN call fires within seconds. Call data shows on a new admin page. A secondary goal: use the calls
themselves as a lead-capture surface (collect email, feed the waitlist).

The three agents:
1. **Insurance demo** — reuses the real `insurance-final-expense-qualifier` template.
2. **Shopify COD-confirmation demo** — reuses the real `shopify-cod-confirmation` template.
3. **"Ask Weeber anything" pitch agent** — net new, freeform, no script, answers questions about the
   product and tries to collect the visitor's email if the conversation goes well.

## The one thing that has to be decided first, and where it landed

A public, unauthenticated form that dials whatever number a visitor types is a **call-bombing /
TCPA-exposure vector** unless the visitor's ownership of the number is verified before the real dial
happens — nothing stops someone entering a stranger's, an ex's, or a competitor's number. I flagged
this and recommended SMS-OTP verification before the call fires.

**Decision (user, 2026-08-26): ship without number verification — checkbox consent only.** This plan
is written to that decision, with the guardrails below built to compensate as much as a checkbox-only
flow reasonably can. This is a real, accepted risk, not an oversight — noted once here so it isn't
silently forgotten six months from now when someone asks "wait, how do we know these numbers were
real."

## What already exists (verified against current code, not assumed)

This is the good news: most of the hard infrastructure is already built and just needs a new front
door.

| Piece | Status | Where |
|---|---|---|
| Compliance chokepoint | **Already applies to any new caller automatically** | `placeOutboundCall` (`voice/place-outbound-call.ts:110`) calls `assertOutboundCallAllowed` unconditionally — DNC (no bypass, ever), TCPA/calling-window, FTSA attempt-cap, insurance gates. A new public endpoint that calls this function inherits all of it for free. |
| Two of the three templates | **Real, seeded, working** | `insurance-final-expense-qualifier`, `shopify-cod-confirmation` (`database/seed.ts`) |
| Per-number Twilio provisioning | **Real, reusable as-is** | `createSubaccountForOrg`/`buyNumberForOrg`-equivalents in `voice/twilio-provisioning.ts` — a dedicated demo org can get its own numbers through the exact same mechanism every merchant org uses |
| Consent recording | **Schema fits this exactly** | `consentRecords` (`database/schema.ts:460-477`) already has `purpose: "marketing"` and `channel: "web"` — this table reads as if it was built with a web-consent-then-call flow in mind |
| Mid-call data capture (email) | **Generic tool exists** | `captureField` (`voice/tools/captureField.ts`) — free-text field capture with a caller-provenance check. Works as-is for email capture, no new tool needed |
| Admin call-list pattern | **Direct model to copy** | `dashboard/calls-list.tsx` / `call-detail.tsx` — a filtered view (`orgId = <demo-org>`) is the fastest path to the new admin page |
| Terms/privacy pages, consent-ledger admin UI | **Already shipped** (2026-07-16, `marketing-and-consent-ui-plan.md`) | `/terms`, `/privacy` are real pages; `dashboard/compliance.tsx` already has a searchable Consent Ledger section that a demo-widget consent record would show up in with zero new UI work |
| Public-unauthenticated → backend-write pattern | **Exists, but shallow** | `WaitlistForm.tsx` posts to an unauthenticated endpoint — but only inserts a DB row. It never triggers telephony. |

## What's genuinely net-new

- **A public, unauthenticated endpoint that triggers `placeOutboundCall`.** Every existing caller of
  that function sits behind org-session or admin auth. This is the first time it would be reachable
  from the open internet, and it's the one piece that needs real engineering care beyond "wire it up"
  — see guardrails below.
- **A demo org** to hold the three templates + two-or-three dedicated numbers (see open question 3).
- **The `weeber-pitch-agent` template** — freeform persona, product FAQ grounding, `captureField` for
  email, no appointment/CRM tools. Larger prompt-injection surface than a scripted agent (nothing
  stops a visitor trying to get it to say something off-brand on a call that's effectively public
  marketing content) — same injection-detection/output-guard machinery every other agent already runs
  through, but worth an explicit adversarial pass before launch given this one has no script to fall
  back to.
- **The widget itself** (`packages/web`, public pages) — phone input, language select, 3-card agent
  picker, consent checkbox with real `/terms` link, call-state UI (ringing → connected → done).
- **The admin demo-calls page** — thin, since it's mostly the existing list pattern filtered to one org.

## Guardrails, given checkbox-only consent

Since number-ownership verification is explicitly out, the abuse surface has to be closed on the
volume/cost side instead:

1. **CAPTCHA on submit** (Turnstile or equivalent) — blocks the trivial scripted-abuse case.
2. **Rate limits**: per-IP (a small number per day), **per-phone-number across all IPs** (this is the
   one that actually matters for the call-bombing case — one real number should not be dialable more
   than once or twice a day no matter who's asking), and a **global daily cap** as a hard cost
   ceiling (every click costs real Twilio + STT + LLM + TTS money on a fully public surface).
3. **DNC + TCPA calling-window are already enforced for free** (see table above) — worth stating
   plainly to whoever signs off on this, since it's real, non-trivial protection already in place
   even without OTP: a number already on the DNC list, or a call attempted outside permitted hours,
   is blocked the same way any merchant's outbound call would be.
4. **Consent record captures the maximum honest audit trail**: phone, `purpose: "marketing"`,
   `channel: "web"`, exact `/terms` version, timestamp, plus IP + user-agent if a metadata field is
   added (schema currently doesn't carry those — small migration, worth it here specifically since
   this is the one record that would matter if this flow is ever challenged).
5. **An instant kill switch** — an env flag or admin toggle that disables the widget without a
   deploy, checked on every request to the public endpoint. Given the risk profile, this should exist
   before launch, not get added after the first incident.

## Rollout sequencing

Not part of tomorrow's live-call test — that's verifying D1-D9 against the existing pipeline; this is
a separate, later phase. Suggested order:

1. **Backend first, internal only**: demo org + two/three templates + provisioned numbers + the new
   public endpoint + all five guardrails above, tested by hand (not yet linked from the real site).
2. **Admin page**: the demo-calls list, so results from phase 1's internal testing are actually visible.
3. **Widget on the live site**, behind a flag or a small rollout — watch real traffic patterns
   (especially per-number/per-IP hit rates) before it's fully exposed, since checkbox-only consent
   means the first real signal of abuse will show up in usage data, not in review.

## Open questions

1. **Rate-limit numbers** — I've named the shape (per-IP, per-number, global daily cap) but not
   picked values; these are a business call more than an engineering one.
2. **Should email-capture be a soft CTA on all three demo calls**, not just the freeform pitch agent
   — e.g. "want a transcript emailed to you?" after the insurance/Shopify demos too — or is
   email-collection deliberately scoped to the pitch agent only?
3. **Two dedicated numbers or three?** The ask named "2 separate, one per agent" but then asked for
   a third freeform pitch agent — worth confirming whether the pitch agent gets its own number (so
   its calls are trivially separable in Twilio's own console too) or shares one of the other two.
4. **Metadata migration for consent records** (IP/UA) — small, additive, worth doing given this is
   the flow's actual audit trail; confirm before it's built rather than added as an afterthought.
