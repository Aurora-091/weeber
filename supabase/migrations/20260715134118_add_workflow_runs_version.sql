/*
# Add version column to workflow_runs for optimistic locking

## Summary
Adds a `version` integer column to `workflow_runs` to enable optimistic concurrency
control (CAS-style updates). This prevents two concurrent triggers from interleaving
their read/write on the same workflow run — the same pattern the scheduler already uses
for `scheduled_calls`, now extended to run advancement.

## Modified Table: workflow_runs
- Added `version` (integer, NOT NULL, default 1) — incremented on every state change;
  updates must include WHERE version = expected_version to prevent stale-write races.

## Notes
1. Existing rows get version=1 (the default).
2. Application code must check .returning() result after UPDATE — if empty, another
   process won the race and this update is a no-op.
*/

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
