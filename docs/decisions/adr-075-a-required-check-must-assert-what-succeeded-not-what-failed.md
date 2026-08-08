# ADR-075: A required check must assert what succeeded, not what failed

- **Date:** 2026-08-08
- **Status:** Accepted
- **Relates to:** ADR-059 (testing infrastructure), ADR-063 (Phase II health data + staging isolation)

## Context

On 2026-08-06, CI run `31124061140` (attempt 1, commit `1337df4`) reported the required status check
**`CI success` = success** while six of the ten jobs it depends on had executed **zero steps**:

```
cancelled  Lint
cancelled  Test (api, web, openvent-compliance)
cancelled  Typecheck (api, web, openvent-compliance)
cancelled  Drizzle migrations match schema.ts
cancelled  Visual regression (78 baselines)
cancelled  A11y
```

The run's own conclusion was `failure`. Only one run exists for that SHA, so this is not two attempts
being confused. The cause of the cancellations was external and is already resolved — githubstatus.com
had `Actions → major_outage` open at the time, and every affected job was killed at exactly 20 minutes
with no steps started, which is a runner-acquisition timeout, not our code.

The outage is not the defect. The defect is that **the gate stayed green through it.**

`ci-success` is the single name configured in branch protection, chosen deliberately (see the comment at
the top of `ci.yml`) so that adding or renaming jobs never means reconfiguring GitHub. That design makes
this one job the entire quality bar for `main`. Its check was:

```yaml
if [ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" = "true" ]; then
```

A deny-list of two strings. GitHub's `needs.<job>.result` has four possible values — `success`,
`failure`, `cancelled`, `skipped` — and a job that is killed before it acquires a runner surfaces to
downstream `needs` as **`skipped`**, which neither branch tested. So the gate passed on a run where
nothing was verified, and a `main` push carrying an untested commit would have been reported as green to
anyone reading the check.

Two other properties made it worse:

1. **The diagnostic was inside the failure branch.** `echo "${{ toJSON(needs) }}"` only ran when the gate
   decided to fail. The single run in this repo's history that most needed explaining therefore logged
   nothing at all, and the mechanism above had to be reconstructed from the REST API afterwards.
2. **It fails open by construction.** Any result string GitHub adds in future — or any typo in the two it
   already matches — silently becomes "pass". A gate whose default answer is yes is not a gate.

## Decision

`ci-success` asserts an allow-list: **every** entry in `needs` must have `result == "success"`, or the
job fails. Anything else — `skipped`, `cancelled`, `failure`, or a value that does not exist yet — fails
closed.

The `needs` table prints unconditionally, before the verdict, so every CI log carries the per-job result
whether the gate passes or not.

The job count is echoed alongside it. `needs` is the only source both the gate and the table read, so the
count is not an independent check on the job list — it is there so a human scanning a green log can see
at a glance that ten jobs were evaluated and not two.

`if: always()` stays. The gate must run even when its dependencies did not, because "did not run" is
precisely the condition it now has to report.

## Alternatives rejected

**Require all ten job names in branch protection instead.** This closes the hole — GitHub will not
consider a `skipped` required check satisfied — but it deletes the property the single-gate design exists
for: every job split, rename or addition would then need a branch-protection edit to match, and the
failure mode of forgetting is a check nobody requires anymore. Trading a bug that is fixable in eight
lines for a permanent maintenance coupling is the wrong trade.

**Add `'skipped'` to the existing `contains(...)` deny-list.** One character short of correct and still
fails open on whatever comes fifth. The problem was never which strings were in the list; it was that the
list enumerated failure.

**Treat `skipped` as acceptable so conditional jobs can be added later.** No job in this workflow is
conditional today, and if one ever is, the honest shape is for that job to run and exit 0 on the
no-op path — not for the gate to stop being able to distinguish "nothing to do" from "never started".

## Consequences

- A green `CI success` now means ten jobs ran and passed. It cannot mean the runners never showed up.
- During an Actions outage, `main` is blocked rather than falsely green. That is the intended behaviour:
  re-run the workflow once the outage clears.
- Every CI log now contains the per-job result table, which shortens the next incident triage from a REST
  API archaeology session to reading the log.
- Depends on `jq`, which is preinstalled on GitHub-hosted `ubuntu-latest`. A self-hosted runner without
  it would fail the gate loudly rather than skip it — the correct direction for this particular job.
- Untouched: what the ten jobs check, when they run, and the fact that `ci-success` is the one required
  status check.

## Verification

The two result strings that previously escaped were confirmed against the failing run through the REST
check-runs API before the fix, and the `jq` expression was exercised locally against a synthetic `needs`
payload containing a `skipped` entry to confirm it is reported and does fail the gate. It cannot be
proven end-to-end without inducing a runner outage; the next real CI run will show the new table.
