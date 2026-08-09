# ADR-086: A template written for one account should not be in everyone else's agent list

- Status: Accepted
- Date: 2026-08-09
- Supersedes: none
- Related: ADR-031 (vertical-agnostic template catalog)

## Context

The agent catalog was implicitly global. `agent_templates` had `vertical` and
`active`, and every org-scoped read filtered on exactly those two:

- `getAgentConfigsForOrg` — what a merchant sees in their agent list
- `provisionVerticalDefaults` — which keys may be auto-enabled on onboarding

So any active template for a vertical was offered to every org in that
vertical. That was correct while the catalog was a curated, generic set. It
stops being correct the moment a template is written *for one account*: a
pilot's own qualifying script, an agency's own flow. That prompt is the
account's material, it encodes their process, and it has no business appearing
in a competitor's agent list in the same vertical.

There was a second, worse edge. Both persona-resolution entry points in
`agent.ts` (`resolvePersona`, `resolveAgentConfig`) resolved a caller-supplied
`explicitPersona` to a template *by key alone*, with no org scoping:

```ts
.where(eq(agentTemplates.key, explicitPersona))
```

`explicitPersona` can arrive from a request. Naming another org's template key
returned its `defaultPersonaPrompt`, which the call then ran on. A guessable
key was a cross-tenant prompt read.

The thing we actually needed was narrower than "template management": a way to
hold a template that exactly one account can see, and to switch it on for them
without waiting for them to find it themselves.

## Decision

Two additive columns on `agent_templates`:

- `visibility text not null default 'public'` — `'public' | 'private'`
- `owner_org_id text references orgs(id) on delete cascade` — nullable

One predicate module, `voice/template-visibility.ts`, is the only definition of
who may see a template:

| row | visible to |
| --- | --- |
| `public` | any org whose `vertical` matches |
| `private` + `owner_org_id = org` | that org, **regardless of vertical** |
| `private` + another owner | nobody else |
| `private` + `owner_org_id is null` | nobody |

Two exported predicates, because the two question shapes are different:

- `visibleTemplatesForVertical(vertical, orgId?)` — listing surfaces
- `visibleTemplatesForOrg(orgId?)` — resolution of an untrusted key, no
  vertical narrowing (a key from a config row or scheduled call is already
  tied to the org)

A bespoke agent stays **one `org_agent_configs` row against a template**, not a
fork and not a copied prompt. Everything an account can customize — persona,
name, greeting/closing, voice + failover chain, language, tools, guardrails —
already lives on that row. Only visibility was missing.

Allocation is `POST /orgs/:orgId/agents/grant` on the admin router:

- 404 on unknown org or unknown template, 400 on inactive template
- **409** rather than reassigning a template privately owned by a different org
- optional `makePrivate: true` claims the template for the org in the same
  request, so "write it, hand it to its account" is one call
- inserts the `org_agent_configs` row with `onConflictDoNothing`, so a
  re-grant is a 200 with `created: false` and never overwrites a config the
  account has since edited (same rule as `provisionVerticalDefaults`)
- writes an `agent.template.granted` admin audit entry

Validation on template create/update refuses to leave a `private` row without
an owner, evaluated against the *post-update* row, not just the request body.

## Consequences

**Existing rows are untouched.** Default `'public'` + null owner reproduces
today's behavior exactly, so the migration (`0047`) is two `ADD COLUMN`s and an
FK — no backfill, no re-seed semantics change. The seeder keeps inserting
public rows.

**Vertical is no longer the only axis.** A private template is offered to its
owner even if the verticals disagree, because it was written for the account,
not the category. That is deliberate; it also means `vertical` on a private row
is now closer to a label than a filter.

**Fail-closed in both new directions.** A private row with a null owner is
invisible rather than global — the ownership branch pairs the owner comparison
with an explicit `is not null` so a null can never satisfy it. And an
unresolvable key in `agent.ts` falls through to the existing
"`explicitPersona` is a raw prompt" branch, exactly as an unknown key always
has: a caller naming a template it cannot see gets its own string treated as a
prompt, not someone else's persona.

**A composition hazard is now load-bearing.** These predicates are `OR`s that
get `AND`ed with `active`. An un-parenthesized `OR` there would make every
public template visible regardless of `active`. A test renders the composed SQL
and asserts the grouping survives, rather than trusting drizzle's precedence by
inspection.

**Not solved here.** There is no merchant-facing UI for any of this — grants
are admin-only by design for now. Nothing prevents an operator from granting
the same public template to many orgs (that's the intended behavior for the
catalog); the 409 only protects rows already claimed as private.

## Verification

`packages/api/src/voice/agent-template-visibility.test.ts` — 23 tests:
predicate SQL text and bound params for all four visibility cases, the
not-null guard, the AND/OR grouping regression, then grant-route auth,
validation, the 409, the `makePrivate` claim, and idempotency.

Full suite green: 1180 pass / 0 fail (1035 api + 74 web + 71 compliance);
typecheck and lint clean.
