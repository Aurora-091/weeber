/*
# Scrub plaintext telephony credentials (audit 2026-07-29 finding #2)

## Summary
Completes the credential-vault cutover the 2026-07-15 setup migration started.
That migration's note #2 promised: "Follow-up migration NULLs plaintext after
full migration." This is that follow-up for the TELEPHONY secrets.

By now the backend already (a) dual-writes every telephony credential to the
vault on provision, and (b) reads vault-first (with a plaintext fallback) on
every call/client/webhook-signature path. This migration removes the remaining
plaintext-at-rest for the actual SECRETS.

## What it does
1. Adds `public.delete_org_credential(org, field)` — a field-scoped vault delete
   (the backend calls it on telephony reset/teardown so a vault-first read never
   resolves a stale credential after the plaintext columns are cleared).
2. Backfills the vault from plaintext for any org whose vault entry is still
   missing (legacy orgs provisioned before dual-write). Idempotent: only writes
   where `read_org_credential(...)` currently returns NULL, so it never clobbers
   a fresher vault value.
3. NULLs the plaintext SECRET columns — but only where the vault now confirms a
   value, so no org can lose its credential. The non-secret IDENTIFIER columns
   (twilio_account_sid, plivo_auth_id, exotel_sid) are intentionally kept: they
   drive "connected" status/UI and are not sensitive.

## Not done here (deliberate)
Dropping the now-always-NULL secret columns is a separate, later migration —
this repo's posture is additive-only schema changes, and keeping the nullable
columns preserves the plaintext fallback path as a safety net until the vault
cutover has been observed healthy in production.

## Secret columns NULLed:  twilio_auth_token, plivo_auth_token, exotel_api_key, exotel_api_token
## Identifier columns kept: twilio_account_sid, plivo_auth_id, exotel_sid
*/

-- 1. Field-scoped vault delete (used by telephony reset/teardown)
CREATE OR REPLACE FUNCTION public.delete_org_credential(
  p_org_id TEXT,
  p_field TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := 'org:' || p_org_id || ':' || p_field;
BEGIN
  DELETE FROM vault.secrets WHERE name = v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_org_credential(TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_org_credential(TEXT, TEXT) TO service_role;

-- 2. Backfill vault from plaintext, only where the vault entry is missing.
--    All fields (identifiers + secrets) are backfilled so the vault-first
--    read paths (which require the full credential set) resolve completely.

-- Twilio (needs account_sid + auth_token together)
SELECT public.store_org_credential(id, 'twilio_account_sid', twilio_account_sid)
FROM orgs
WHERE twilio_account_sid IS NOT NULL
  AND public.read_org_credential(id, 'twilio_account_sid') IS NULL;

SELECT public.store_org_credential(id, 'twilio_auth_token', twilio_auth_token)
FROM orgs
WHERE twilio_auth_token IS NOT NULL
  AND public.read_org_credential(id, 'twilio_auth_token') IS NULL;

-- Plivo (needs auth_id + auth_token together)
SELECT public.store_org_credential(id, 'plivo_auth_id', plivo_auth_id)
FROM orgs
WHERE plivo_auth_id IS NOT NULL
  AND public.read_org_credential(id, 'plivo_auth_id') IS NULL;

SELECT public.store_org_credential(id, 'plivo_auth_token', plivo_auth_token)
FROM orgs
WHERE plivo_auth_token IS NOT NULL
  AND public.read_org_credential(id, 'plivo_auth_token') IS NULL;

-- Exotel (needs sid + api_key + api_token together)
SELECT public.store_org_credential(id, 'exotel_sid', exotel_sid)
FROM orgs
WHERE exotel_sid IS NOT NULL
  AND public.read_org_credential(id, 'exotel_sid') IS NULL;

SELECT public.store_org_credential(id, 'exotel_api_key', exotel_api_key)
FROM orgs
WHERE exotel_api_key IS NOT NULL
  AND public.read_org_credential(id, 'exotel_api_key') IS NULL;

SELECT public.store_org_credential(id, 'exotel_api_token', exotel_api_token)
FROM orgs
WHERE exotel_api_token IS NOT NULL
  AND public.read_org_credential(id, 'exotel_api_token') IS NULL;

-- 3. NULL the plaintext SECRET columns, only where the vault confirms a value.
UPDATE orgs SET twilio_auth_token = NULL
WHERE twilio_auth_token IS NOT NULL
  AND public.read_org_credential(id, 'twilio_auth_token') IS NOT NULL;

UPDATE orgs SET plivo_auth_token = NULL
WHERE plivo_auth_token IS NOT NULL
  AND public.read_org_credential(id, 'plivo_auth_token') IS NOT NULL;

UPDATE orgs SET exotel_api_key = NULL
WHERE exotel_api_key IS NOT NULL
  AND public.read_org_credential(id, 'exotel_api_key') IS NOT NULL;

UPDATE orgs SET exotel_api_token = NULL
WHERE exotel_api_token IS NOT NULL
  AND public.read_org_credential(id, 'exotel_api_token') IS NOT NULL;
