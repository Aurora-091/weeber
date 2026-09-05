/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Backend origin for all API calls (see lib/api.ts). Unset = same-origin
   * (single-deploy). Set to the Railway backend URL when the frontend is
   * deployed separately on Vercel.
   */
  readonly VITE_API_BASE_URL?: string;
  /** Supabase project URL for merchant dashboard auth. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key for merchant dashboard auth. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Which surface this build serves: public | admin | user | all.
   * See lib/route-base.ts and app.tsx.
   */
  readonly VITE_APP_SURFACE?: string;
  /** Marketing site origin for cross-subdomain links (domains.ts). */
  readonly VITE_WWW_ORIGIN?: string;
  /** Admin dashboard origin for cross-subdomain links (domains.ts). */
  readonly VITE_ADMIN_ORIGIN?: string;
  /** Merchant app origin for cross-subdomain links (domains.ts). */
  readonly VITE_APP_ORIGIN?: string;
  /** Enables the visual harness routes in non-DEV builds (app.tsx). */
  readonly VITE_UI_HARNESS?: string;
  /** robots meta tag content baked into index.html at build time. */
  readonly VITE_ROBOTS_META?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
