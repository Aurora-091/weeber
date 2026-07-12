import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase Auth client for the user app (/app/*) only — the admin panel
 * keeps its separate admin-key auth (two systems on purpose, see CLAUDE.md).
 * Configured via VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (build-time,
 * same regime as VITE_API_BASE_URL). When unconfigured, the user app
 * renders a "not configured" notice instead of crashing — local dashboards
 * that only use /dashboard never need these set.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url!, anonKey!) : null;
