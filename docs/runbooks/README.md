# Runbooks

Operator checklists. Each file here is a sequence a human executes against a
live environment, in order, with a verifiable end state.

A runbook is not an ADR. ADRs in `docs/decisions/` record *why* a constraint
exists; a runbook records the *steps needed to work within it today*. When a
runbook step exists only because of an unfixed gap, it names the ADR so the
step can be deleted once the gap closes.

| Runbook | Use when | Last verified against code |
| --- | --- | --- |
| [insurance-pilot-first-call.md](./insurance-pilot-first-call.md) | Standing up a brand-new insurance-vertical org and placing its first real call | 2026-08-13 (`7a31a0c`) |
