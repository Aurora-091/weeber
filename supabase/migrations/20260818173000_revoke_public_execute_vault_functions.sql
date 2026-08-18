/*
# Revoke the implicit PUBLIC grant on credential-vault functions

## Summary
`20260715133208_setup_credential_vault.sql` and `20260729120000_scrub_
telephony_plaintext_credentials.sql` each end with
`REVOKE ALL ON FUNCTION ... FROM anon, authenticated;` and intended that to
lock the vault functions down to `service_role` only. It doesn't: Postgres
grants `EXECUTE` to the implicit `PUBLIC` pseudo-role on every function by
default at CREATE time, and revoking from two named roles (`anon`,
`authenticated`) never touches that separate PUBLIC grant. `anon` and
`authenticated` still had EXECUTE the whole time, inherited through PUBLIC —
confirmed directly via `information_schema.routine_privileges` on the
project migrated to on 2026-08-18, where all four functions showed
`grantee = PUBLIC`.

Impact: `public.read_org_credential`/`store_org_credential`/
`delete_org_credential(s)` are SECURITY DEFINER functions that read/write
Supabase Vault — reachable via PostgREST at `/rest/v1/rpc/<function_name>`.
With the PUBLIC grant standing, anyone holding only the project's public
anon/publishable key (not a login, not the service_role secret) could call
`read_org_credential` with an arbitrary `org_id` and retrieve any org's
decrypted Twilio/Plivo/Exotel auth token.

## Fix
Explicitly revoke from PUBLIC (which is the only grant that actually
matters here — revoking the named roles again is redundant but harmless)
and re-grant to service_role only.

## Scope
Applied directly (2026-08-18) to both post-migration Supabase projects
before this file existed in source control; this file exists so a fresh
`supabase db push` against a new project reproduces the fix instead of the
bug, and so this stays fixed if either project's functions are ever
CREATE OR REPLACE'd again without this file being reapplied after.
*/

REVOKE ALL ON FUNCTION public.store_org_credential(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_org_credential(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_org_credential(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_org_credentials(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.store_org_credential(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_org_credential(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_org_credential(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_org_credentials(TEXT) TO service_role;
