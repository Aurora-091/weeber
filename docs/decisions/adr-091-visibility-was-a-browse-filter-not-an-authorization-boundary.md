# ADR-091: Visibility was a browse filter, not an authorization boundary

- Status: Accepted
- Date: 2026-08-10
- Supersedes: none
- Amends: ADR-086 (completes it — the columns and predicates it added were applied
  to 4 of ~10 read sites)
- Related: ADR-080 (a permission check that cannot fail is not a permission
  check), ADR-090 (the reachability ratchet), ADR-088 (a guard with no callers is
  documentation)

## Context

ADR-086 added `agentTemplates.visibility` + `ownerOrgId` and two predicates
(`visibleTemplatesForVertical`, `visibleTemplatesForOrg`) so a template written
for one account stops appearing in every other merchant's agent list. That part
shipped and works.

It was applied in **four** places: `agent.ts:485`, `agent.ts:603`,
`org-queries.ts:145`, `org-queries.ts:188` — all of them *list* reads. Every
read that resolved a template **by key** was still a bare
`where(eq(agentTemplates.key, key))`:

| site | what it returned |
| --- | --- |
| `agent.ts` `resolvePersona` | the template row incl. `defaultPersonaPrompt` |
| `agent.ts` `resolveAgentConfig` | same, for the live call config |
| `agent.ts` no-config-row branch | `literalGreetingTemplate` |
| `agent.ts` `buildPreviewAgentConfig` | same, for the preview drawer |
| `workflows/ai-draft.ts` `listAvailablePersonaKeys` | **every active template key in the table** |
| `org-queries.ts` `upsertAgentConfig` | wrote a config row for any key |
| `org-queries.ts` `assignPhoneNumberToAgent` | attached a number to any key |

`templateKey` is a URL path param on merchant-authenticated routes
(`/api/app/agent-configs/:templateKey/*` — six routes today, and the count has
only ever gone up). So the list filter hid other tenants' templates from the UI
while the by-key routes handed them over on request: `POST
/agent-configs/<their-key>/test-chat` returned that account's
`defaultPersonaPrompt` — the exact value the schema comment on `visibility`
calls "that account's IP" — and the AI-draft system prompt *enumerated every
private key in the table* for any merchant who asked for a draft.

This is the same shape as ADR-080 and ADR-088: the check exists, is documented,
and is not on the path that needs it. The structure (three layers: public
catalog template → per-org `orgAgentConfigs` instance → bespoke private
template) is right and is not being redesigned. Enforcement was the gap.

Nothing was exploited: all 9 rows in the deployed `agent_templates` are
`visibility = public`, `owner_org_id = null`, so today every read returns the
same thing whether it is scoped or not. That is precisely why this had to be
fixed *before* the first bespoke pilot template exists, not after — the day a
private row is inserted, seven read paths start leaking it with no visible
change in behavior to signal it.

## Decision

**1. One supported way to read a template by key.** `loadVisibleTemplate(key,
orgId?)` in `template-visibility.ts` is the only shape allowed; the unfiltered
`where(eq(agentTemplates.key, …))` has no remaining reason to be written. It
returns `null` — never a partial row, never a throw — and `isTemplateVisibleToOrg`
is the yes/no form for write paths.

**2. Not-found and not-visible are the same answer.** 404 with
`No agent template "<key>" is available to this org`, identical for a key that
does not exist and one this org may not see. A distinguishable response turns
every write endpoint into an oracle for enumerating private keys, which defeats
the point of the column.

**3. The check is at the route boundary *and* in the resolvers.** A
`requireVisibleTemplate` middleware is mounted once on
`/agent-configs/:templateKey` and `/agent-configs/:templateKey/*`, because
per-handler checks are what produced this ADR — `test-chat` is the route that
forgot. `loadVisibleTemplate` also stays inside
`resolvePersona`/`resolveAgentConfig`/`buildPreviewAgentConfig`, since those have
callers that never pass through that router (admin routes, the WS test-call
path, the scheduler). Defence in depth here is deliberate, not redundant.

**4. Writes validate the key before writing.** `upsertAgentConfig` returns
`{ok:true;row} | {ok:false;error}` instead of a row, and both it and
`assignPhoneNumberToAgent` guard with `isTemplateVisibleToOrg`.

**5. Enumeration is scoped too.** `listAvailablePersonaKeys` takes an `orgId`
and goes through `visibleTemplatesForVertical(org.vertical, orgId)`. An
unresolvable org yields an empty list, which the prompt already renders as "no
agents configured yet" — fail closed, not fall back to the whole catalog.

**6. `orgAgentConfigs.templateKey` gets a real FK** to `agentTemplates.key`, no
`ON DELETE` action (templates are retired with `active = false`, never deleted,
so a delete that would orphan live customer config should fail loudly). Verified
zero orphan rows in the deployed DB across all 16 config rows before adding it.

**7. `active` stays out of the visibility predicates.** "Still offered" is a
different question from "belongs to you", and a call already in flight on a
since-retired template must still resolve.

**8. The customization rule, written down:** customer customization is *always*
an `orgAgentConfigs` row. A private template exists only when the script is
IP-distinct and needs its own tool set and greeting template. Without this,
"make it theirs" drifts into cloning a template per account, and the catalog
stops being a catalog.

## Consequences

- `upsertAgentConfig`'s callers (user route, admin route) handle a result
  object; the user route 404s on `!ok`.
- Six `/agent-configs/:templateKey*` routes are covered by one mount, and any
  route added under that prefix is covered by default rather than by remembering.
- A merchant naming a template that does not exist now gets 404 instead of a
  silently-created config row that resolves to nothing at call time.
- 10 new tests: the by-key predicate SQL (asserted on the rendered clause, since
  a fake db that ignores `where` would pass a query that dropped its scoping),
  null-not-partial-row, no-org fail-closed, `active` deliberately absent, the
  two write guards, the fail-closed persona list, and a route test asserting
  `test-chat` 404s before `resolveAgentConfig` is ever reached.

## Explicitly deferred

- **Bespoke → catalog promotion** (`makePublic`). Zero bespoke templates exist;
  designing a lifecycle for a population of zero is premature.
- **Prompt versioning** (`agentTemplateVersions`). Real need, separate decision.
- **Plan-based catalog entitlement** (which tier sees which template). Not a
  visibility question — visibility is tenancy, entitlement is billing.
- **The India/non-India axis** (`agentTemplates.region` vs `orgs.countryCode`,
  a shared `resolveRegion`). Part 2 of the same audit, unchanged by this ADR:
  nothing in the API reads `countryCode` for behavior yet.
