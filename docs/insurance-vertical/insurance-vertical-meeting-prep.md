# Insurance client meeting — technical + compliance prep

Not a public-facing doc, not a decision record — a working brief for the upcoming insurance client
meeting. Confirmed live demo expected. Use case confirmed as reminders + lead follow-up (not claims,
not fraud verification — keep the pitch scoped to what's actually built).

## What's real and demo-ready right now

- **Two working agent personas, seeded into the live database**: `insurance-policy-renewal` (renewal /
  premium-due reminder calls) and `insurance-lead-followup` (qualifying and booking inbound leads with a
  licensed advisor). Full scripts at `docs/agent-prompts/04-insurance-policy-renewal-agent.md` and
  `05-insurance-lead-followup-agent.md` — read these before the meeting, they're what the agent will
  actually say.
- **Both explicitly refuse to quote, advise, or sell** — every guardrail section says outright: no
  premiums, no coverage terms, no negotiation, escalate to a licensed human for anything regulated. This
  is deliberate and should be your opening line if anyone asks "can it just close the sale" — the honest
  answer is no, by design, because that's licensed-agent territory (IRDAI), and a platform that pretended
  otherwise would be a liability, not a feature.
- **The live voice test call** (built and verified this session, Agent Preview drawer) works for these
  templates the same as it does for Shopify's — once an org is set to `vertical: "insurance"`, opening
  that agent's Preview → Voice tab → Start test call gives a real, live, in-browser conversation with
  the actual agent. This is your demo mechanism — no phone number needed, no separate setup, works
  straight from a laptop in the room.
- **India-specific compliance is already enforced in the calling engine, not just talked about**:
  - TRAI's TCCCPR calling-window rule (9am–9pm IST, not the US TCPA's 8am–9pm) is enforced specifically
    for +91 numbers (`packages/openvent-compliance/src/calling-window.ts`) — this is a real, coded rule,
    not a policy document.
  - Every call opens with a spoken AI + recording disclosure by default, not opt-in
    (`packages/openvent-compliance/src/consent.ts`) — satisfies IRDAI's mandatory consent-notification
    expectation and the EU AI Act's AI-disclosure requirement in one mechanism.
  - Org-scoped Do-Not-Call enforcement and a full per-call audit trail already exist and are enforced
    before every dial, not logged after the fact.

## Be honest about this gap, don't oversell it

- **The National DNC/NDNC-TRAI-registry sync is a documented drop-in, not a live integration.** The
  architecture has a named extension point for it (`packages/openvent-compliance/src/national-dnc.ts`),
  matching the same pattern already used for the (also not-yet-wired) US National DNC Registry. If asked
  "are you synced with the NCPR/DND registry," the accurate answer is: "the calling-window and
  per-number consent enforcement is live today; registry sync is architected and is a fast follow once we
  know which registry access method you already have (most insurers already have NCPR/DLT registration
  through their existing telemarketing setup — we'd plug into that, not stand up a new one)." That's a
  credible, specific answer — better than either overclaiming it's done or being vague.
- **DPDP Act (India's data protection law)**: the existing GDPR-shaped org-scoped erasure/audit
  architecture is structurally the same kind of thing DPDP requires (data principal rights, consent
  records, erasure), but this hasn't been reviewed against DPDP specifically — say "our data-handling
  architecture already does org-scoped consent tracking and erasure the same way GDPR requires, and DPDP
  alignment is something we'd confirm together against your specific data flows," not "we're DPDP
  certified" (no such certification exists to claim yet, be precise about that).
- **No live CRM/policy-system integration exists yet** (unlike Shopify's OAuth-based connector) — the
  lead/reminder data in a real deployment would need to come from wherever their policy admin system or
  lead source lives. Frame this as "tell us your policy admin system and lead source, we build the
  connector the same way we did for Shopify" rather than implying it's plug-and-play today.

## Positioning, in one paragraph

Weeber isn't a generic voice-AI wrapper — the platform is provider-abstracted (not locked to one
STT/LLM/TTS vendor, so pricing and quality aren't hostage to one company's roadmap) and compliance is
built into the calling engine itself, not bolted on as a policy document. For insurance specifically: the
agent's entire design assumes it is not a licensed seller — it reminds, qualifies, and hands off, which is
both the safer regulatory posture and, frankly, the only honest one for an AI voice agent talking to
someone about their insurance.

## If the meeting goes well and they want a real pilot next

Needed before a real (non-demo) deployment: (1) their actual lead/policy data source to connect, (2)
confirmation of their existing NCPR/DLT telemarketing registration so the DND-sync fast-follow has
something to plug into, (3) a decision on whether renewal reminders, lead follow-up, or both go first —
same "one thing, proven, before the second" discipline applied to Shopify vs. Clinic applies here too;
don't commit to building both at once under real client pressure.
