---
adr: 25
title: "Multi-user dashboard auth: labeled API keys, not accounts"
date: 2026-07-08
status: Accepted
---

## ADR-025 — Multi-user dashboard auth: labeled API keys, not accounts
**Date:** 2026-07-08

**Context:** `ADMIN_API_KEY` (a single shared env-var secret) is fine for a solo operator but has no way
to tell which team member or integration used a key, and no way to revoke one person's access without
rotating the secret for everyone. Explicitly scoped down by the user to labeled API keys, not real
username/password accounts — this is the framework's own operator auth, not a customer-facing product
login system.

**Decision:** New table `adminKeys` (additive): `label`, `keyHash` (SHA-256, not a slow password hash —
these are high-entropy generated tokens with no offline-guessing risk, and a fast hash keeps every
admin-gated request cheap), `createdAt`, `lastUsedAt`, `revokedAt` (soft-delete, keeps an audit trail
instead of a hard row delete). `middleware/admin-auth.ts` checks two paths in order: (1) the legacy
`ADMIN_API_KEY` env var — **this path never goes away**, every existing deployment already has it set;
(2) a labeled key hash lookup. The original "nothing configured → warn and allow" local-dev fallback is
preserved, but now conditioned on *no labeled key ever having been created either* — once an operator
deliberately starts using labeled keys, an unset env var shouldn't silently reopen the gate. New
endpoints `POST/GET /admin-keys` and `DELETE /admin-keys/:id`, all gated by `requireAdminKey` itself
(you need a valid key to create more). New dashboard page `/dashboard/settings` — generate a key, see it
in plaintext exactly once with a copy button, list existing keys with created/last-used timestamps,
revoke.

**Consequences:** No breaking change for any existing deployment — `ADMIN_API_KEY` alone continues to
work exactly as before if an operator never touches the new feature. `hashAdminKey` unit-tested directly
(deterministic, collision-resistant across different inputs, fixed-length output, never leaks the
plaintext); the DB-touching CRUD functions aren't unit-tested against a real database, consistent with
this project's existing pattern for DB-touching code elsewhere. Verified with the (now-actually-working,
see ADR-024) `tsc -b`, `vite build`, and the full test suite.
