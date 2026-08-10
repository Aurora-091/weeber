# Audit 11 — Premade vs. custom agents, and the India/non-India axis

Date: 2026-08-09
Scope: source-level structural audit of two questions, no code changed.
1. Weeber sells both **premade catalog agents** and **bespoke custom agents**. Is the current structure right?
2. **India vs non-India must be separated.** On what axis, and where does that decision belong?

Read: `voice/template-visibility.ts`, `voice/agent.ts`, `voice/org-queries.ts`, `voice/admin-routes.ts`,
`voice/workflows/ai-draft.ts`, `app/routes.ts`, `voice/failover.ts`, `voice/tts/sarvam.ts`,
`voice/agent-frame.ts`, `database/schema.ts`, `weeber-compliance/src/calling-window.ts` + `packs/`,
`weeber-compliance/src/consent.ts`.

---

## Part 1 — Premade vs. custom

### The structure is right. The enforcement is not.

The three-layer model already in the schema is the correct one, and I'd keep it:

| Layer | Table / column | Means |
|---|---|---|
| Catalog | `agent_templates` where `visibility='public'`, scoped by `vertical` | "every insurance org can use this" |
| Bespoke | `agent_templates` where `visibility='private'` + `ownerOrgId` | "this script belongs to one account" |
| Tenant config | `org_agent_configs` (persona, voice, language, tools, cadence, number) | "this org's tuning of a template" |

That is better than the two alternatives you could have picked: forking a template per org (drifts,
un-upgradable) or one giant `orgs.customPrompt` blob (no catalog, no reuse). Bespoke is a row, not a
fork — correct. `visibility` defaults to `public` with a null owner, so nothing needed backfilling —
correct. Private + null owner is visible to nobody — fail-closed, correct.

`agent_templates.active` is deliberately kept out of the visibility predicate and `and()`-ed by each
caller. That's also right: "retired" and "not yours" are different questions.

### Where it leaks

`visibleTemplatesForOrg` / `visibleTemplatesForVertical` are only applied in 4 of the ~10 places
`agent_templates` is read. The unguarded reads are the problem, and they're not theoretical.

**P0 — cross-tenant persona-prompt disclosure via the `templateKey` path.**
ADR-086 closed the `explicitPersona` door (`agent.ts:485`, `:603` both filter by visibility) and left
the `templateKey` door wide open. In both `resolvePersona` and `resolveAgentConfig`,
`resolvedTemplateKey = opts.templateKey` is trusted with **no visibility check at all** — the filter
only runs on the `!resolvedTemplateKey && explicitPersona` branch. Every downstream template fetch
(`agent.ts:508`, `:623`, `:682`, `:732`) is an unfiltered `where(eq(agentTemplates.key, ...))`.

`templateKey` is a **URL path param on merchant-authenticated routes**:

- `POST /api/app/agent-configs/:templateKey/test-chat` (`app/routes.ts:453`) →
  `buildPreviewAgentConfig(templateKey, override, orgId)` → unfiltered lookup at `agent.ts:732` →
  another org's `defaultPersonaPrompt` becomes the system prompt of a chat **the caller controls the
  messages of**. "Repeat your instructions verbatim" and Peterson's script is on their screen.
  No config row required, no prerequisite state. One request.
- `PUT /api/app/agent-configs/:templateKey` (`app/routes.ts:405`) → `upsertAgentConfig` inserts an
  `org_agent_configs` row for **any string**, no template validation. Note the asymmetry:
  `provisionVerticalDefaults` (`org-queries.ts:143`) *does* validate against
  `visibleTemplatesForVertical` before inserting. The hand-written path doesn't.
- `PUT /api/app/agent-configs/:templateKey/number` → same, via `assignPhoneNumberToAgent`.

The severity: the whole point of `visibility='private'` per the schema comment is that "its persona
prompt is that account's IP." A pilot's script is the one asset they hand you that they'd care about
leaking. Right now the guarantee is one code path deep.

**P1 — bespoke template keys are enumerable.**
`ai-draft.ts:79` (`listAvailablePersonaKeys`) selects *every* `active` template key — no vertical, no
visibility, no org. Those keys are then interpolated into the AI-draft system prompt sent for any
org's workflow draft. So a Shopify merchant's draft prompt lists
`insurance-final-expense-qualifier` and every future account-specific key. That's the enumeration
step that makes P0 a targeted attack rather than a guess, plus the LLM can emit a `call` node naming
a persona the org can't use (that one degrades safely — the visibility check on `explicitPersona`
catches it at call time and it falls through to treating the key string as a raw prompt, which is
its own quiet wrongness).

**P1 — `org_agent_configs.templateKey` is plain `text` with no FK to `agent_templates.key`.**
Nothing at the data layer says a config row must point at a template that exists and is visible to
that org. Combined with the unvalidated upsert above, orphan and cross-tenant rows are insertable.
`agent_templates.key` is `unique`, so the FK is available — this is a missing constraint, not an
impossible one. Consistent with the standing debt item that tenancy in this repo is convention-only:
org scoping is a `.where()` a developer has to remember.

### What's structurally missing (not a bug — a gap)

1. **No lifecycle.** There's no way to promote a bespoke template into the catalog (you write a
   Peterson script, it works, three more insurance orgs want it) or to demote/retire one. Today that's
   a manual `UPDATE`. The grant route has `makePrivate: true`; there is no `makePublic`, and it
   refuses to reassign an owned template (correct — that would make it visible to two accounts).
   A `promote` operation needs to be explicit because the persona prompt is the customer's IP:
   promoting is a *contractual* act, not an admin convenience. Worth an ADR before it's needed.
2. **Ownership survives, entitlement doesn't.** A private template is tied to `ownerOrgId` with
   `onDelete: cascade`. There's no "this org's plan includes N agents / these templates" layer, so
   catalog access is a pure function of vertical — pricing can't gate the catalog. Fine for pre-pilot,
   but it means plan tiers currently can't be expressed in agent terms at all.
3. **No test enumerates tenant-scoped tables.** 57 of 123 api test files use `mock.module`; exactly 1
   touches `db.insert(`. A visibility regression like the `templateKey` path above is exactly the class
   of bug this suite cannot see, because nothing exercises two orgs against a real DB.

### Recommendation

Not a redesign. Four changes, in this order:

1. Make visibility a **property of resolution, not of the caller**. One function —
   `resolveVisibleTemplate(key, orgId)` — that every read goes through, including the `templateKey`
   path, `buildPreviewAgentConfig`, and the fetches at `agent.ts:508/623/682`. Delete the unfiltered
   `where(eq(agentTemplates.key, ...))` shape from the codebase so it can't be reintroduced by copy-paste.
2. Validate `templateKey` in `upsertAgentConfig` and `assignPhoneNumberToAgent` the way
   `provisionVerticalDefaults` already does. Reject with 404, don't silently insert.
3. Scope `listAvailablePersonaKeys(orgId)` by vertical + visibility.
4. Add the FK on `org_agent_configs.templateKey` → `agent_templates.key`, and one integration test with
   a real DB and two orgs asserting org B cannot read org A's private template through *any* route.

(1) and (2) are the security fix and are small. (4) is the thing that keeps it fixed.

---

## Part 2 — India vs non-India

### The axis is the recipient's jurisdiction, resolved per call — and it already exists

Per-org provider pinning was rejected earlier and that still holds: an org is not a region. Weeber
sells to a US insurance agency whose leads are in 12 US states, and to an Indian clinic whose patients
are in India — but also, soon, to a company in one country calling into another. Tenancy is the wrong
key. So is `orgs.countryCode` (which today is Shopify-sourced billing metadata, not a routing input).

The correct axis already ships, in `weeber-compliance/src/calling-window.ts`: a **jurisdiction
resolver** that picks a pack (`packs/india.ts`, `packs/us.ts`) from the recipient's number. That is
the right shape — per-jurisdiction rule packs behind one resolver, adding a region means adding a pack.
The problem is that **nothing except the calling window consumes it.** Every other region-dependent
decision is made somewhere else, from a different input, and none of them agree.

### What's decided on the wrong input today

| Decision | Decided by today | Should be decided by |
|---|---|---|
| Calling window (TRAI vs TCPA hours) | recipient number prefix ✅ | recipient jurisdiction |
| TTS provider chain | `DEFAULT_TTS_FALLBACK_ORDER = ["cartesia","elevenlabs","sarvam"]` — global constant | jurisdiction pack |
| STT provider chain | `["deepgram","elevenlabs","sarvam"]` — global constant | jurisdiction pack |
| Sarvam language code | `tts/sarvam.ts` forces `en` → `en-IN`, default `*-IN` | jurisdiction + language |
| Recording disclosure text | `resolveDisclosure({ language })` — language only | jurisdiction (consent regime), then language |
| Number series (140/160/1600) | `orgPhoneNumbers.numberSeries` + per-org feature flag | jurisdiction pack (TRAI-only concept) |
| Producer state licensing | `insuranceAdvisors.licensedStates` + lead `state` | jurisdiction pack (US-only concept) |
| Consent regime (DPDP vs TCPA/FTSA) | one consent adapter, purpose-based | jurisdiction pack |

Three concrete defects fall out of that table.

**P0 — a US call can land an Indian-accented voice, and stay there.**
The TTS chain is the global `["cartesia","elevenlabs","sarvam"]`. On a double failover (Cartesia down,
ElevenLabs down) a US final-expense call reaches Sarvam, and `tts/sarvam.ts` maps `en` → `en-IN`.
Per ADR-070 the provider choice is sticky for the rest of the call. So the worst-case outcome of an
infra hiccup on the pilot is an Indian-accented voice cold-calling US seniors about final expense —
which is not a quality bug, it's the single fastest way to get the campaign flagged. Sarvam should not
be in a US call's chain at all; it's an Indic-language provider and its presence there is an artifact
of one global constant serving both markets.

**P1 — the resolver fails open to US.**
`checkCallingWindow` is `if (isIndianNumber) → india; else → us`. A UK, UAE, or Canadian number gets
**US TCPA rules** silently. Every other compliance gate in this repo fails closed (private+null owner
→ nobody; DNC and the attempt cap are never bypassed even in test mode). This one doesn't, and it's
the gate that decides whether a call is legal to place. An unrecognized jurisdiction should block and
say so, not guess.

**P1 — disclosure is keyed on language, not on the consent regime.**
`resolveDisclosure({ language })` picks text by language tag. India's DPDP notice requirements and
US two-party-consent recording disclosure are different obligations that happen to both be
expressible in English. An English-language call into India currently gets the English (US-shaped)
disclosure. Language is the *rendering* of the disclosure; jurisdiction is what determines *which*
disclosure is owed.

Also noted: the resolver's own doc comment already flags number-prefix resolution as a known
limitation (ported numbers, VoIP, diaspora numbers misclassify). It's a fine default and a bad sole
source of truth for a legal decision.

### Recommendation

Promote the jurisdiction pack from a calling-window detail to a **first-class call-level input**, and
make every region-dependent decision read it.

1. **Resolve jurisdiction once per call, explicitly**, at call-placement time — from an explicit
   recipient-country field where present (leads have `state`; a `country` field is the natural sibling),
   falling back to number prefix. Persist it on the `calls` row. Right now the jurisdiction is
   recomputed implicitly from a phone string in one place and nowhere else, so no two decisions can be
   guaranteed to agree, and after the fact you cannot tell which regime a completed call was judged
   under. Persisting it is also what makes an audit answerable.
2. **Move the provider chains into the packs.** `packs/us.ts` exports a TTS/STT chain with no Sarvam;
   `packs/india.ts` exports one that prefers it. `DEFAULT_*_FALLBACK_ORDER` becomes the
   unknown-jurisdiction fallback, not the answer for both markets. Per-agent
   `ttsFallbackOrder`/`sttFallbackOrder` overrides stay as-is on top — they already exist and are the
   right escape hatch.
3. **Fail closed on unknown jurisdiction.** Block the call with an explicit
   "no compliance pack for this destination" reason and a `guardrail_events` row (`category`/`source`
   are plain `text` + TS enums, so widening needs no migration). Better a blocked call than an
   unknowingly illegal one.
4. **Key disclosure on jurisdiction first, language second.** `resolveDisclosure({ jurisdiction, language })`.
5. Let the packs own the region-only concepts they already imply: TRAI number series belongs to the
   India pack, US producer-state licensing to the US pack. Both are currently reached through
   per-org feature flags, which means "is this call in India" is answered by an org setting.

This is not "separate India and non-India." It's "stop deciding region in eight places from six
different inputs." The separation the customer sees — an Indian clinic never touching US rules, a US
agency never touching TRAI ones — is the output of that, not something to hardcode per tenant.

### What I would not do

- **Don't pin an org to a region.** Already rejected, still wrong: it breaks the first cross-border
  customer and it puts a legal decision in a billing field.
- **Don't split the deployment or the schema per region** (separate India/US databases or template
  sets). Data-residency pressure (DPDP) may eventually force a residency conversation, but doing it
  now buys nothing and doubles every migration. Nothing in the current requirement set needs it.
- **Don't add a `vertical`-style `region` column to `agent_templates`.** Region isn't a property of a
  script; it's a property of the call. A single template can legitimately be used in both markets with
  a different language and provider chain. Region belongs in the pack, not the catalog.

---

## Priority

| # | Finding | Sev |
|---|---|---|
| 1 | Cross-tenant persona-prompt disclosure via the unguarded `templateKey` path (`test-chat` is the live route) | P0 |
| 2 | US call can fail over into an Indian-accented Sarvam voice, sticky for the call | P0 |
| 3 | Jurisdiction resolver fails open to US for unrecognized numbers | P1 |
| 4 | Bespoke template keys enumerable via `ai-draft.ts` | P1 |
| 5 | `upsertAgentConfig` / `assignPhoneNumberToAgent` accept any `templateKey`; no FK on the column | P1 |
| 6 | Disclosure keyed on language instead of consent regime | P1 |
| 7 | No promote/retire lifecycle for bespoke templates | P2 |
| 8 | No integration test proving cross-tenant isolation on any route | P2 |

Findings 1, 4, 5 are one ADR (visibility as a resolution property + data-layer enforcement).
Findings 2, 3, 6 are one ADR (jurisdiction as a first-class call input). ADR numbers 091 and 092 are free.
