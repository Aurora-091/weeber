import { Hono } from 'hono';
import { cors } from "hono/cors"
import { voice } from "./voice/routes";
import { shopify } from "./integrations/shopify/routes";
import { resolveTtsProvider } from "./voice/tts";
import { resolveLlmProvider, getActiveModelLabel } from "./voice/llm";
import { isHipaaMode, getRetentionDays, isDisclosureEnabled } from "@openvent/compliance";

// Cross-origin policy for the split deploy (frontend on Vercel, API on
// Railway — ADR-035). CORS_ALLOWED_ORIGINS: comma-separated origin allowlist
// (e.g. "https://app.weeber.example,https://admin.weeber.example"). Unset =
// reflect any origin — today's single-deploy behavior, acceptable while auth
// is header-based (no cookies), but set the allowlist before the Vercel
// frontend goes live on a real domain.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = new Hono()
  .basePath('api')
  .use(
    cors({
      origin: (origin) => {
        if (allowedOrigins.length === 0) return origin ?? "*";
        return origin && allowedOrigins.includes(origin) ? origin : null;
      },
      credentials: true,
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
  .route('/', shopify);
// Note: the Twilio Media Stream WebSocket (/api/voice/stream) is handled
// natively in server.ts, not through this Hono app — see voice/ws-route.ts.

export type AppType = typeof app;
export default app;
