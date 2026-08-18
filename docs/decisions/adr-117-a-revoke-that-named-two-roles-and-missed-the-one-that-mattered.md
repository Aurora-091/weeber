# ADR-117 — A revoke that named two roles and missed the one that mattered

- **Date:** 2026-08-18
- **Status:** Accepted (fixed same day, on both live projects and in source)

## Context

While bringing the new staging Supabase project (`zbcrwexrqfmjxhewirgp`) to schema parity with the new
production project (`qghtkadxbtptvbfbmsdz`) — replaying `supabase/migrations/*.sql`, the raw-SQL
migration set that lives alongside Drizzle's own `packages/api/drizzle/` and covers what Drizzle's
schema.ts can't express (Supabase Vault functions, storage buckets, RLS policies) — a live check against
`information_schema.routine_privileges` on both projects, done to confirm the replay actually reached
parity, surfaced something that had nothing to do with parity: all four credential-vault functions
(`store_org_credential`, `read_org_credential`, `delete_org_credential`, `delete_org_credentials`) were
directly executable by `PUBLIC` — on both projects, including the pre-existing production one.

`20260715133208_setup_credential_vault.sql` and its follow-up `20260729120000_scrub_telephony_
plaintext_credentials.sql` each end with `REVOKE ALL ON FUNCTION ... FROM anon, authenticated;` and both
say, in their own header comments, that this makes the functions "Only callable by service_role." It
doesn't. Postgres grants `EXECUTE` to the implicit `PUBLIC` pseudo-role on every function at `CREATE
FUNCTION` time by default, and `anon`/`authenticated` inherit through PUBLIC same as everyone else —
revoking two named roles never touches the PUBLIC grant underneath them. The migration correctly names
the two roles it was worried about and misses the one whose default state actually matters.

**Impact:** these four functions are `SECURITY DEFINER` — they run with the privileges of the function
owner (which can reach `vault.secrets`/`vault.decrypted_secrets`) regardless of who calls them — and
Supabase's PostgREST layer exposes every function in the `public` schema at `/rest/v1/rpc/<name>` to
anyone holding the project's public anon/publishable key, no login required. With the PUBLIC grant
standing, `POST /rest/v1/rpc/read_org_credential` with an arbitrary `org_id` and a known field name
(`twilio_auth_token`, `plivo_auth_token`, `exotel_api_key`, `exotel_api_token` — all named directly in
`credential-vault.ts`) returned any org's decrypted telephony secret to an anonymous caller. This is the
exact class of exposure the 2026-07-15 vault migration and the 2026-07-29 plaintext-scrub follow-up existed
to close — undone by one missing role in a REVOKE statement.

## Decision

Revoke from `PUBLIC` explicitly (revoking the named roles again alongside it is redundant but harmless —
kept for clarity, not because it does anything PUBLIC's revoke doesn't already cover) and re-grant to
`service_role` only, the only role that legitimately calls these (`packages/api`'s own `DATABASE_URL`
connection, and Railway's `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY`).

Applied immediately against both live projects via `execute_sql`/`apply_migration` (Supabase MCP), then
captured as `20260818173000_revoke_public_execute_vault_functions.sql` — additive, not an edit to the
two original files, matching this repo's own stated posture ("this repo's posture is additive-only
schema changes," per the 2026-07-29 file's own comment) — so a fresh `supabase db push` against any
future project reproduces the fix, not the bug, and so this stays fixed if the functions are ever
`CREATE OR REPLACE`'d again without every migration since being replayed in order.

Verified via `information_schema.routine_privileges` on both projects post-fix: `grantee` is now exactly
`{postgres, service_role}` for all four functions, PUBLIC absent.

## Rejected

- **Editing the two original migration files in place.** They're supposed to represent what was actually
  run, historically, in order — rewriting them would desync source from the applied-migration ledger
  (`supabase_migrations.schema_migrations`) on any project where they already ran, and this repo's own
  convention (matched from ADR-078's Drizzle-side equivalent) is correction-in-a-new-file, not silent
  rewrite.
- **Assuming this only mattered for the two new post-account-migration projects.** The check that found
  this was run against the *old* account's would-be-successor production project first — i.e., production
  had this exposure before this session touched anything. Not something introduced by the Supabase
  account migration; something the migration replay incidentally surfaced by forcing a direct grant check
  that nothing had done before.

## Consequences

Both live Supabase projects (production `qghtkadxbtptvbfbmsdz`, staging `zbcrwexrqfmjxhewirgp`) no longer
expose vault-backed telephony credentials to unauthenticated callers. No functional change for the
backend's own `service_role` access path — `credential-vault.ts` is unaffected.

**Known and unfixed:**

- **No evidence either way on whether this was ever exploited.** Supabase's `query_logs`/PostgREST access
  logs weren't audited as part of this fix — this ADR closes the hole, it does not establish whether
  anyone ever walked through it. If that matters, pull PostgREST logs for `/rest/v1/rpc/read_org_credential`
  and `/rest/v1/rpc/store_org_credential` going back to 2026-07-15 (when the vault functions first existed)
  separately.
- **The same "REVOKE named roles, not PUBLIC" mistake could exist elsewhere.** Only the four
  credential-vault functions were checked directly against `information_schema.routine_privileges` in
  this pass — any other `SECURITY DEFINER` function created via `supabase/migrations/*.sql` (there are
  none as of this date, per `pg_proc` filtered on `prosecdef = true`) should get the same direct grantee
  check before being trusted, not just a read of its migration file's stated intent.
