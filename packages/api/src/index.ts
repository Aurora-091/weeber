import { Hono } from 'hono';
import { cors } from "hono/cors"
import { voice } from "./voice/routes";
import { admin } from "./voice/admin-routes";
import { workflowAdminRoutes } from "./voice/workflows/admin-routes";
import { userApp } from "./app/routes";
import { publicRoutes } from "./app/public-routes";
import { leadsIngest } from "./voice/leads/ingest";
import { shopify } from "./integrations/shopify/routes";
import { resolveTtsProvider } from "./voice/tts";
import { resolveLlmProvider, getActiveModelLabel } from "./voice/llm";
import { isHipaaMode, getRetentionDays, isDisclosureEnabled } from "@openvent/compliance";
import { requestLogger } from "./middleware/request-logger";
import { errorHandler } from "./middleware/error-handler";
import { assertCorsConfiguredForProduction, buildCorsOriginResolver } from "./middleware/cors-config";

// Cross-origin policy for the split deploy (frontend on Vercel, API on
// Railway — ADR-035). CORS_ALLOWED_ORIGINS: comma-separated origin allowlist
// (e.g. "https://app.weeber.example,https://admin.weeber.example"). Unset in
// production = refuse to boot (audit 2026-07-19 finding #3 — was previously
// a silent reflect-any-origin fallback); unset outside production still
// reflects any origin so local dev/CI need zero extra config. See
// middleware/cors-config.ts.
assertCorsConfiguredForProduction();

const app = new Hono()
  .basePath('api')
  .onError(errorHandler())
  .use("*", requestLogger())
  .use(
    cors({
      origin: buildCorsOriginResolver(),
      credentials: true,
      // Explicit allowlist because both auth headers are non-simple — with a
      // CORS origin allowlist set, preflights would otherwise reject them.
      allowHeaders: ["Content-Type", "Authorization", "X-OpenVent-Admin-Key"],
      exposeHeaders: ["set-auth-token"],
    }),
  )
  .get('/ping', (c) => c.json({ message: `Pong! ${Date.now()}` }, 200))
  .get('/health', (c) =>
    c.json(
      {
        status: 'ok',
        keysConfigured: {
          deepgram: Boolean(process.env.DEEPGRAM_API_KEY),
          elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
          cartesia: Boolean(process.env.CARTESIA_API_KEY),
          groq: Boolean(process.env.GROQ_API_KEY),
          // Reported because Indic routing silently depends on it: both
          // resolveSttProvider (stt/index.ts) and resolveTtsProvider
          // (tts/index.ts) only switch a Hindi call onto Sarvam when this key
          // is present, and fall back to the platform default when it isn't.
          // That fallback is invisible at runtime — a Hindi call just sounds
          // worse — so the key's presence has to be observable from health.
          // `activeTtsProvider` below cannot stand in for it: it resolves with
          // no language argument, so it reports the non-Indic default either way.
          sarvam: Boolean(process.env.SARVAM_API_KEY),
          twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
          publicUrl: Boolean(process.env.PUBLIC_APP_URL),
          aiGateway: Boolean(process.env.AI_GATEWAY_API_KEY),
          webhookUrl: Boolean(process.env.WEBHOOK_URL),
        },
        activeTtsProvider: resolveTtsProvider(),
        activeLlmProvider: resolveLlmProvider(),
        activeModel: getActiveModelLabel(),
        compliance: {
          hipaaMode: isHipaaMode(),
          recordingDisclosureEnabled: isDisclosureEnabled(),
          dataRetentionDays: getRetentionDays(),
        },
      },
      200,
    ),
  )
  .route('/voice', voice)
  .route('/voice', admin)
  .route('/workflows', workflowAdminRoutes)
  .route('/app', userApp)
  .route('/public', publicRoutes)
  .route('/leads', leadsIngest)
  .route('/', shopify);
// Note: the Twilio Media Stream WebSocket (/api/voice/stream) is handled
// natively in server.ts, not through this Hono app — see voice/ws-route.ts.

export type AppType = typeof app;
export default app;
