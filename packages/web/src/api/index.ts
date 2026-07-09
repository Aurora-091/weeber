import { Hono } from 'hono';
import { cors } from "hono/cors"
import { voice } from "./voice/routes";
import { shopify } from "./integrations/shopify/routes";
import { resolveTtsProvider } from "./voice/tts";
import { resolveLlmProvider, getActiveModelLabel } from "./voice/llm";
import { isHipaaMode, getRetentionDays, isDisclosureEnabled } from "@openvent/compliance";

const app = new Hono()
  .basePath('api')
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
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
