/*
# Set up credential encryption via Supabase Vault

## Summary
Creates helper functions for encrypting per-org telephony credentials (Twilio/Plivo/Exotel)
using Supabase Vault. Credentials are stored encrypted in vault.secrets and decrypted
on-demand via vault.decrypted_secrets — the encryption key is managed by pgsodium
infrastructure and never leaves the database server's memory.

## New Functions
- `public.store_org_credential(p_org_id TEXT, p_field TEXT, p_value TEXT)` — stores/updates encrypted credential
- `public.read_org_credential(p_org_id TEXT, p_field TEXT)` — reads decrypted credential
- `public.delete_org_credentials(p_org_id TEXT)` — removes all credentials for an org

## Security
- Functions are SECURITY DEFINER (run as function owner with vault access)
- Only callable by service_role (the backend)
- Revoked from anon/authenticated roles

## Notes
1. Credentials stored with predictable names: `org:{org_id}:{field_name}`
2. Existing plaintext columns in `orgs` remain during transition — backend reads vault
   first, falls back to plaintext. Follow-up migration NULLs plaintext after full migration.
3. pgsodium extension is pre-enabled on this project.
*/

-- Store or update an org credential in the vault
CREATE OR REPLACE FUNCTION public.store_org_credential(
  p_org_id TEXT,
  p_field TEXT,
  p_value TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := 'org:' || p_org_id || ':' || p_field;
  v_existing_id uuid;
BEGIN
  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = v_name;

  IF v_existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_id, p_value, v_name, 'org credential: ' || p_field);
  ELSE
    PERFORM vault.create_secret(p_value, v_name, 'org credential: ' || p_field);
  END IF;
END;
$$;

-- Read a decrypted org credential from the vault
CREATE OR REPLACE FUNCTION public.read_org_credential(
  p_org_id TEXT,
  p_field TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := 'org:' || p_org_id || ':' || p_field;
  v_value TEXT;
BEGIN
  SELECT decrypted_secret INTO v_value
  FROM vault.decrypted_secrets
  WHERE name = v_name;

  RETURN v_value;
END;
$$;

-- Delete all credentials for an org (cleanup on org deletion)
CREATE OR REPLACE FUNCTION public.delete_org_credentials(
  p_org_id TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM vault.secrets
  WHERE name LIKE 'org:' || p_org_id || ':%';
END;
$$;

-- Only service_role (backend) can call these
REVOKE ALL ON FUNCTION public.store_org_credential(TEXT, TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.read_org_credential(TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_org_credentials(TEXT) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.store_org_credential(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_org_credential(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_org_credentials(TEXT) TO service_role;
