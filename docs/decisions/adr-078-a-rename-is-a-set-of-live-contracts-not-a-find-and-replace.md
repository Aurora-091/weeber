# ADR-078: A rename is a set of live contracts, not a find-and-replace

- **Date:** 2026-08-08
- **Status:** Accepted
- **Supersedes / relates to:** ADR-019 (full rebrand from Vent to OpenVent — the precedent that historical records are left as originally written)

## Context

The product is Weeber. The codebase still said `OpenVent` in 294 places: an agent persona spoken
aloud to callers, an HTTP request header, a workspace package name, a Redis key prefix, code
comments, and documentation. The request was to replace it "everywhere across the platform."

`rg -l openvent | xargs sed -i 's/OpenVent/Weeber/g'` would have produced a green-looking diff and
broken four things that no test in this repo asserts. The 294 matches are not one kind of thing —
they are seven, and each carries a different blast radius:

| Category | What it is | Why a word swap is wrong |
|---|---|---|
| A | `DEFAULT_PERSONA` in `agent.ts` | Spoken to real callers. The old text was factually false. |
| B | `X-OpenVent-Admin-Key` header | A live wire contract with callers this repo cannot redeploy. |
| C | `@openvent/compliance` package | A folder name, a package name, import specifiers, a lockfile, CI job filters, and one **relative-path** test mock. |
| D | `openvent:session:` Redis prefix | A live keyspace. Renaming it mid-flight strands in-progress calls. |
| E | ADRs, changelog, audits | Historical records of what was decided and when. |
| F | Code comments, live docs | Genuinely safe. |
| G | The GitHub repository name itself | Out of band — changes the `origin` URL and Railway/Vercel source links. |

Each category was executed or deliberately skipped on its own merits, with the user's explicit
approval per category. A, B, C, D and F were approved. E was declined. G was deferred.

### A — the persona was not a word swap, it was a lie

The old default persona opened with `You are OpenVent, …` and then told any caller who asked:

> OpenVent is a self-hosted voice pipeline — the open alternative to black-box voice AI platforms.
> The person running this owns the code, the database, and the call logic on their own
> infrastructure.

Weeber is a managed multi-tenant SaaS. None of that is true of a Weeber call, and it is being said
out loud to a merchant's or clinic's customer. `s/OpenVent/Weeber/g` would have kept every false
claim and simply attached the new brand to it — the worst available outcome, because it also
volunteers the vendor's name to a caller who dialed the *business*.

This is not a dormant string. `loadPersonaMap` reads `AGENT_PERSONAS` from the environment, and
`AGENT_PERSONAS` is **absent** in Railway production. `DEFAULT_PERSONA` is the live fallback for
every call that does not carry its own agent persona.

### B — the header is a contract with callers we cannot see

`X-OpenVent-Admin-Key` is sent by this repo's frontend, and also by whatever else holds an admin
key: operator `curl` scripts, saved Postman/Bruno collections, cron jobs. Renaming the header
in-place fails those callers with a 401 at whatever hour they next run, with no signal that a rename
caused it.

### C — the one gotcha that a name-only rename would have hidden

`packages/api/src/voice/workflows/scheduler.test.ts:112` mocks the compliance package **by relative
folder path**, not by package name:

```ts
mock.module("../../../../openvent-compliance/src/index", …)
```

Renaming only the package *name* leaves this mock pointing at a directory that no longer exists.
`mock.module` does not fail on an unresolvable specifier — it silently stops intercepting. The test
keeps passing while exercising the real compliance engine instead of the mock.

### D — safe today for one reason only

`REDIS_URL` is absent in production, so `createSessionStore()` returns `MemorySessionStore` and there
is no persistent keyspace to orphan. With Redis live, changing the prefix strands every in-progress
call's session under the old prefix: `get()` misses, the agent loses its captured fields, and
`size()` under-reports.

## Decision

**Rename by category, with the blast radius of each category decided before the edit — and treat a
brand rename as a live-contract change, not a text edit.**

1. **A — rewrite, don't swap.** `DEFAULT_PERSONA` is now vendor-neutral. It identifies as "an AI
   assistant answering for this business", discloses that it is AI when asked, and explicitly
   **refuses to name, describe, or promote the software it runs on**, offering a human handoff for
   technical questions instead. A regression test in `agent.test.ts` asserts the persona contains
   neither `openvent` **nor** `weeber` — it locks the *absence* of any vendor name, so the same
   defect cannot return under the new brand.

2. **B — dual-accept, permanently.**
   `c.req.header("X-Weeber-Admin-Key") ?? c.req.header("X-OpenVent-Admin-Key")`. The legacy name is
   **not deprecated on a timer.** Accepting a second header name grants no additional access, because
   the key itself is still the only secret; dropping it later buys nothing and breaks admin access
   silently. The new name is checked first so a stale legacy value cannot win when both are sent. The
   401 body names both. `index.ts` CORS `allowHeaders` lists **both** — omitting the legacy name
   there would make browser preflight reject it even though the server accepts it.
   `admin-auth-header.test.ts` covers dual-accept, new-name precedence, wrong key, and no header.

3. **C — rename the folder, the package, the imports, the lockfile, the CI filters, and the relative
   mock path.** `git mv packages/openvent-compliance packages/weeber-compliance`;
   `@openvent/compliance` → `@weeber/compliance`; `bun install` regenerated the lockfile (`rg openvent
   bun.lock` → no matches); the stale `node_modules/@openvent` symlink was removed; `ci.yml` path
   filters and job display names updated. `ci-success`'s `needs:` array was **not** touched — job
   *display* names changed, job *ids* did not, so the single branch-protection check is unaffected.

4. **D — rename the prefix now, with the migration hazard written next to it.** A comment on
   `keyPrefix` records that this was safe only because Redis is off, and that a future rename with
   Redis live requires read-both/write-new rather than an edit.

5. **E — historical records are left as originally written**, per ADR-019. `docs/decisions/**`,
   `docs/changelog/**`, `audit/**`, `docs/audits/**`, `docs/archive/**`, `ci-triage-notes.md`,
   `ui-audit.md`, `ui-implementation-plan.md` and the dated `docs/product-strategy/*` files keep their
   prose as written. An ADR that says "we renamed the header" must still contain the name it had.

   **One exception, deliberate:** dated documents received **path-only** updates
   (`packages/openvent-compliance` → `packages/weeber-compliance`) so their file references still
   resolve. A historical record is a record of a decision, not of a directory layout; a path that
   404s is not history, it is rot. Brand names in their prose were not touched.

6. **F — comments and live docs renamed**, and the "fork of OpenVent" framing removed entirely:
   Weeber is its own product, not a downstream fork. `AGENTS.md`, `README.md`,
   `docs/brain/project-brief.md` and the `architecture/README.md` positioning section were rewritten
   — the last one now states plainly that provider abstraction is a **margin and resilience lever for
   Weeber the operator**, not a customer-facing feature. `README.md` was also corrected where it
   falsely listed `mobile` and `desktop` packages that do not exist.

7. **G — the GitHub repository remains `Aurora-091/openvent`** until decided separately. It is not a
   code change; it rewrites the `origin` URL and the Railway/Vercel source links.

**Explicitly out of scope:** `packages/web/src/web/lib/admin-key.ts` `STORAGE_KEY =
"vent_admin_key"`. It is a browser `sessionStorage` key; renaming it logs out every admin with no
message. It was not in the 294-match set and is left alone.

## Consequences

- Callers hear an honest, vendor-neutral assistant. The persona no longer describes an architecture
  the platform does not have, and no longer names its vendor to a business's customer.
- Every existing admin caller keeps working, forever, with no migration window.
- The compliance package is `@weeber/compliance` end to end — folder, name, imports, lockfile, CI —
  with no dead mock. Post-rename it is independently green: typecheck clean, 71 tests / 140
  assertions.
- Historical records stay readable as records, and their internal links still resolve.
- Full verification chain green: root lint 0 errors / 0 warnings (465 files); `api` typecheck clean,
  **956 pass / 0 fail** across 114 files (up from 950/113 — five dual-accept cases and one persona
  guard); `web` typecheck clean, 74 pass; functional e2e 2 passed; visual suite **78 passed** after a
  baseline update.
- The visual baseline change is the tightest available proof that this rename did not touch the UI:
  exactly **three** PNGs changed — `dash-dnc` at 1440-light, 390-light and 1440-dark — because the
  single rendered string in the entire 294-match set is `<code>@weeber/compliance</code>` on the DNC
  page. Every other web-side diff is a header value or a comment.
- The dual-accept header is permanent surface area. It is documented in `docs/reference/security.md`
  so it reads as a decision rather than as forgotten cleanup.
- Two brand names remain in the repo by design: the legacy header name, and the git repo name.

## Alternatives considered

- **`sed -i` across all 294 matches.** Rejected: it would have shipped a false persona under a new
  brand, 401'd every unredeployable admin caller, left a silently-dead relative-path mock in
  `scheduler.test.ts`, and rewritten history.
- **Deprecate the old header with a sunset date.** Rejected: the deadline creates the outage it claims
  to prevent. There is no security benefit to retire — the key is the secret, not the header name.
- **Keep `DEFAULT_PERSONA`'s structure and just change the noun.** Rejected: the defect was the
  claims, not the name. See A above.
- **Rewrite historical ADRs and changelog entries to say Weeber.** Rejected per ADR-019. A record
  that has been edited to match the present is no longer evidence of the past.
- **Rename the Redis prefix later, together with enabling Redis.** Tempting, and it is the *safe*
  order. Rejected because it defers a rename into the exact moment it becomes dangerous, when the
  reason it was deferred will have been forgotten. Doing it while the keyspace is empty is free; the
  hazard is recorded in a comment for whoever turns Redis on.
- **Also rename `vent_admin_key` in `sessionStorage`.** Rejected: silent logout for every admin, zero
  user-visible benefit.
