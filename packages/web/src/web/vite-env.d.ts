/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Backend origin for all API calls (see lib/api.ts). Unset = same-origin
   * (single-deploy). Set to the Railway backend URL when the frontend is
   * deployed separately on Vercel.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
