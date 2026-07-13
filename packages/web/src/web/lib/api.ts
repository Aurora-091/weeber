import { hc } from "hono/client";
import type { AppType } from "@weeber/api";

/**
 * Single seam between the frontend and the backend's location (ADR-035).
 *
 * Unset/empty (default): same-origin — today's single-deploy behavior, where
 * the Bun server serves both the API and the built frontend.
 * Set (e.g. `VITE_API_BASE_URL=https://api.weeber.example`): every API call —
 * typed RPC client and raw fetch alike — targets that origin instead. This is
 * what lets the Vercel-hosted frontend talk to the Railway-hosted backend,
 * and later lets the backend move into its own package/repo without touching
 * any call site.
 *
 * Build-time value (Vite inlines it) — changing it means rebuilding the
 * frontend, not just restarting it.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** Prefix an `/api/...` path with the configured backend origin. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/**
 * Drop-in `fetch` for the handful of call sites that need raw HTTP (status
 * checks, text/blob downloads) instead of the typed RPC client. Never call
 * global `fetch` with a hardcoded `/api/...` path from frontend code — it
 * would silently pin that call site to same-origin.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

const client = hc<AppType>(API_BASE_URL || "/");

export const api = client.api;
