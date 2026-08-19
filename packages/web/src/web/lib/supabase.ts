import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase Auth client, used by both the public surface's /login (weeber.ai)
 * and the user app's authenticated pages (app.weeber.ai) — NOT by the admin
 * panel, which keeps its separate admin-key auth (two systems on purpose,
 * see CLAUDE.md). A session created on /login is handed to app.weeber.ai
 * explicitly via /auth/callback, since supabase-js's localStorage-backed
 * session is per-origin and the two surfaces are different domains in
 * production. Configured via VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
 * (build-time, same regime as VITE_API_BASE_URL). When unconfigured, pages
 * that need it render a "not configured" notice instead of crashing — local
 * dashboards that only use /dashboard never need these set.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url!, anonKey!) : null;
