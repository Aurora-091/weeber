# ADR-118 — A doc nobody can date is a doc nobody can retire

- **Date:** 2026-08-21
- **Status:** Accepted (audit executed 2026-08-20, `ba2ed76`; this ADR records the governance rule it ran on)

## Context

A full audit of every `.md` in the repo against the code it describes (2026-08-20, commit `ba2ed76`)
found four documents that were not merely stale but *actively misleading*: `docs/reference/api-reference.md`
documented 19 endpoints against a real surface of roughly 180; `docs/reference/dashboard.md` listed 7 of
the 23 pages in `packages/web/src/web/pages/dashboard/` and stated `/dashboard` as a fixed prefix that
`adminPath()` (`packages/web/src/web/lib/route-base.ts`) had already made configurable;
`docs/reference/security.md` told the reader to run `scripts/tunnel-supervisor.sh`, and **there is no
`scripts/` directory in this repo** and no `cloudflared` reference anywhere in the code; `.env.example`
was missing 37 variables the code reads and still advertised two (`ELEVENLABS_VOICE_ID`,
`CARTESIA_VOICE_ID`) that nothing has read since ADR-102.

Fixing the contents was the easy half and is not what this ADR is about. The hard half was that **the
repo had no rule for what to do with a doc the code has moved past**, and the absence showed: nine
loose `.md` files sat at the repo root with no folder, no owner and no convention distinguishing
"current" from "finished". One of them, `Untitled.md`, was twelve lines of unlabelled latency numbers
with no title, no date, no owner and no reference from anywhere in the repo — literally unattributable.
Others were finished task trackers whose own banners said `✅ COMPLETE` months ago.

Without a rule, every one of those files is a permanent judgement call, and the default judgement is
"leave it, someone might need it" — which is how a root directory becomes nine files deep and how a
reader loses the ability to tell a live spec from a closed tracker. AGENTS.md rule #2 requires an ADR
for consequential choices; the audit made four of them (archive vs delete vs rewrite-in-place; where a
dated audit artifact belongs; whether code citations move with a file; how to retire a doc that lives in
an append-only folder) and recorded none. This is that ADR, written the day after, deliberately as a new
file rather than by editing the changelog entry that already shipped.

## Decision

**Retire a doc by its class, not by its age or its filename.** Four classes, four dispositions:

1. **Evergreen reference — rewrite in place.** `docs/reference/` is undated by convention: the filename
   makes a promise that the file is current. Superseding `api-reference.md` with a dated copy would break
   that promise and leave the reader choosing between two files, which is the problem the folder exists to
   prevent. So the three wrong reference docs were rewritten from source and keep their names.

2. **Dated point-in-time artifact — file it with its own class, never archive it for being old.**
   `ui-audit.md` was a measured, dated audit, the same species as everything in `audit/`. It moved to
   `audit/2026-08-03-audit-ui-ux-full-surface.md` with an index row, **not** to `docs/archive/`. Archiving
   would have asserted it was superseded; it is not superseded, it was merely in the wrong folder, and its
   findings are still cited by name from live gate code (`tools/ui-guard/tokens.json`,
   `tools/ui-guard/contrast-gate.ts`, `packages/web/e2e-visual/a11y.spec.ts`).

3. **Superseded plan or finished tracker — `git mv` to `docs/archive/` plus a reason row.** The row must
   name *what superseded it* and the date. A file in `docs/archive/` with no reason row is indistinguishable
   from a file someone lost.

4. **No attributable reason — delete.** `Untitled.md` was deleted rather than archived, precisely because
   archiving demands a reason row and there was no reason to write: no title, no date, no owner, and no
   reference to it from anywhere. Archiving it would have manufactured provenance for a file that had none.

Two rules cut across all four:

- **Code citations move in the same commit as the file.** A doc move that leaves
  `tools/ui-guard/contrast-gate.ts` pointing at a filename that no longer exists creates exactly the
  dangling-reference class the audit was cleaning up. Repointing later is a second commit that never
  happens. This is enforced by grepping the filename across the repo before every move.
- **Append-only folders are moved, never edited.** `docs/changelog/**`, `docs/decisions/**`,
  `docs/archive/**`, `audit/**`, `docs/audits/**`, `docs/product-strategy/**` and `docs/agent-prompts/**`
  are history. A `git mv` preserves a file's bytes verbatim and is therefore compatible with append-only;
  rewriting its contents is not. Where those files contain paths that have since moved, **the stale paths
  are left alone** — they are accurate records of what was true when written, and correcting them would
  destroy the only evidence of what the repo looked like then.

`docs/agent-prompts/` is additionally **immovable**, not just append-only: `packages/api/src/database/seed.ts`
resolves it at runtime from `import.meta.dir`, so a rename breaks seeding silently. The api test suite is
the check that this stayed true.

## Rejected

- **Deleting the finished trackers instead of archiving them.** They carry the reasoning behind decisions
  the code no longer explains — `ui-phase0-notes.md` records why Phase 0 was scoped the way it was. Deleting
  a document because its checklist is complete throws away the *why* and keeps only the *what*, which is
  backwards; the code already holds the what.
- **Archiving `ui-audit.md` with the rest of the root cleanup.** Filename-driven triage would have swept it
  up with the other four root files. It failed that triage on its contents: still-cited, still-true, wrong
  folder only. This is the reason the rule is class-based and the reason each candidate is read before it is
  moved.
- **Dating the three reference docs (`api-reference-2026-08-20.md`) instead of rewriting them.** Consistent
  with `audit/`, inconsistent with `docs/reference/`, and it would leave the wrong version in place as the
  undated one — the file most likely to be read.
- **Correcting the stale paths inside `docs/changelog/` and older ADRs while there.** Tempting, since the
  link checker flags them. Refused on ADR-078's precedent: a shipped record says what was believed then, and
  a repo where history is quietly edited to match the present cannot be used to reconstruct anything.
- **Leaving the root alone and only fixing contents.** The four wrong documents were findable *because*
  someone went looking; the nine-file root is why nobody had. Contents and placement are the same problem.

## Consequences

The repo root holds nine `.md` files, and `README.md`'s "Where things live" table now indexes every one of
them and says that it does — so a new root file is visibly missing from a table rather than invisibly
present in a directory. `docs/archive/README.md` carries a dated reason row per archived file.

Follow-on application of this same rule (2026-08-21) moved four completed trackers out of the live tree:
`docs/insurance-language-variants-task.md` (all ten steps checked off and verified 2026-07-19; its one
flagged open gap — no `hinglish` key in the compliance disclosure map — has since been closed in code at
`packages/weeber-compliance/src/consent.ts`), `docs/product-strategy/leads-layer-build-task.md`,
`docs/product-strategy/leads-phase2-3-build-task.md` and `docs/product-strategy/PHASE23-PROGRESS.md` (all
three carrying `✅ COMPLETE` banners from 2026-07-19). The first of those is cited from four live code
comments, all repointed in the same commit per the rule above.

`docs/workflow-canvas/v3-user-builder-plan.md` was a candidate and **failed triage deliberately**: its own
header says "not started", which by filename-and-banner reading is a clear archive. Reading v4 shows it
supersedes only v3's frontend section and cites v3's data model, trigger catalog, `condition` node type and
permission model as unchanged and load-bearing. Archiving it would have orphaned live citations in a shipped
plan. It is the worked example of why banners are not sufficient evidence.

**Known and unfixed:**

- **Most of `docs/` is still unaudited for accuracy.** This ADR governs *retirement*, and the 2026-08-20 pass
  verified the reference docs and the root. `architecture/{data-model,user-flow,voice-orchestration}.md`,
  `docs/reference/{resources,contract,live-call-test-protocol}.md`, `packages/api/TESTING.md`,
  `packages/web/README.md`, `packages/weeber-compliance/README.md` and `docs/brain/*` have not been checked
  against code. A doc not yet caught disagreeing with the code is not the same as a doc that agrees with it.
- **Nothing enforces any of this.** The rule is a convention in a document; there is no CI gate asserting
  that every file in `docs/archive/` has a reason row, that no root `.md` is missing from README's table, or
  that a moved doc left no dangling citation. The three audit scripts that found this round of breakage
  (`linkcheck`, `pathcheck`, `envcheck`) live in `/tmp` outside the repo and will not survive the sandbox —
  porting them into `tools/` behind a CI job is the obvious next step and was not done.
- **`AGENTS.md`'s traction claim ("11 calls all-time, zero customer traffic") is unverified** and was left
  as-is; it is checkable against production and nobody checked it during the audit.
