# ADR-087: A merge tag no ingest path can fill is not bound

- Status: Accepted
- Date: 2026-08-09
- Supersedes: none
- Amends: ADR-085 (an outbound agent that cannot name who it called)
- Related: ADR-081 (regulated scope), native-leads-layer-plan-2026-07-19 §4/§5

## Context

ADR-085 fixed an outbound agent that could not say the name of the person it
had dialled: three templates opened with `{{lead_name}}` / `{{interest_area}}`
/ `{{policyholder_name}}`, nothing bound any of them, the unresolved-tag guard
rejected the line, and every such call fell back to an LLM-improvised greeting.
`getLeadGreetingContext` was added to bind them from the lead row.

That fix was verified by a test that assigns `leads.fields` directly. Which is
exactly why it looked complete and was not.

`fields` is not written directly by anything real. Every ingest path — agent
`captureField`, hosted form, webhook, Pipedream, CRM — flows through
`validateFields`, which is allowlist-shaped: **keys not in the intake schema
are dropped**, silently and by design. And `interest_area` was not in the
insurance intake schema. Neither was `state`.

So the production chain was:

```
source sends interest_area
  -> validateFields drops it as unknown
  -> leads.fields never contains it
  -> getLeadGreetingContext returns no interest_area
  -> guard rejects the opener
  -> LLM improvises the greeting
```

The binding worked. The field could not arrive. The unit test proved the half
of the chain that was never broken, and the defect ADR-085 was written to close
was still live in production, one layer further down.

Two smaller things surfaced with it:

- The `product_interest` enum was `term|health|motor|life|travel|other` — an
  India-market list with no final-expense value at all, in the vertical whose
  first pilot script is a final-expense script.
- Nothing in the system recorded a lead's **state**. In the US, insurance
  licensure attaches to an individual producer in a state. A lead in a state
  where the agency has no licensed advisor has nowhere legal for a warm
  transfer to land — and under ADR-081 the warm transfer is the entire point of
  the agent. That is a pre-dial routing decision, and it was being made with
  data the system did not have.

## Decision

1. Add `interest_area` (free text) and `state` (free text) to the insurance
   intake schema, and `final_expense` to the `product_interest` enum.

2. Keep `interest_area` and `product_interest` as **separate** fields. They are
   different kinds of thing and collapsing them breaks one of the two:
   `product_interest` is an enum the leads table filters, groups and reports
   on; `interest_area` is a phrase read aloud verbatim to a consumer in the
   first sentence of the call. An enum is not sayable — "you'd recently reached
   out about final_expense" is not a sentence a human says.

3. When a source sends only the enum (the common case for a CRM or CSV export,
   which carries a category rather than a sentence), derive the spoken phrase
   from a small explicit map. Unmapped values — `other` — yield **no**
   `interest_area`, so the guard rejects the line and the generic greeting is
   used. A generic greeting beats asserting the wrong product to a consumer on
   a recorded line.

4. `state` is free text, not an enum, because it must hold US states and Indian
   states, and `coerce` stores out-of-options enum values anyway — an enum here
   would imply validation it does not perform.

5. Test the **round trip**, not the lookup: source payload -> `validateFields`
   -> stored `fields` -> merge tags. Including a negative case asserting the
   regulated keys the pilot script asks for (`dob`, `routing_number`,
   `medical_conditions`) are still rejected from the same payload that carries
   the new fields, so widening the schema cannot be mistaken for relaxing
   ADR-081.

## Consequences

- The scripted opener can now actually resolve, on the pipeline a real lead
  arrives through rather than only in a test that hand-writes `fields`.
- State-based transfer routing becomes *possible*. It is not implemented: no
  code yet refuses to dial a lead in a state with no licensed advisor. The data
  exists now, the decision does not.
- Widening an intake schema is the one change that can quietly relax the
  ADR-081 boundary, since the same allowlist that drops junk is what blocks
  regulated keys. Any future addition needs the same paired negative test.
- General rule taken from this: a merge tag is bound when a real ingest path
  can fill it end to end. A unit test that writes storage directly proves the
  binding, not the feature — and the layer it skips is where the defect lives.

## Not decided here

There is **no CSV lead importer** in the product. `POST /leads/ingest` is a
JSON API-key endpoint; the leads page offers export, not import. The pilot's
stated primary delivery method is a CSV, which means today it has to be pushed
as JSON by us on their behalf. Header aliasing (mapping `first_name`,
`lead_type`, `FEX` and similar export column names onto intake keys) belongs to
that importer and is deferred with it.
