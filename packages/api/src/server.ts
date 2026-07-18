import app from "./index";
import { tryUpgradeVoiceSocket, voiceWebsocketHandlers } from "./voice/ws-route";
import { tryUpgradeWaitlistSocket, waitlistWebsocketHandlers } from "./app/waitlist-ws";
import { assertHipaaPreflight, startRetentionSweep } from "@openvent/compliance";
import { callLogAdapter } from "./voice/compliance/adapters";
import { assertVoiceConfig } from "./voice/config-check";
import { startScheduledCallSweep } from "./voice/workflows/scheduler";
import { initSentry, captureError } from "./utils/sentry";

// Error monitoring (2026-07-18) — no-op if SENTRY_DSN is unset, same
// convention as RESEND_API_KEY elsewhere. Must run before anything else has
// a chance to throw.
initSentry();

// Surface any otherwise-silent crash (e.g. an unawaited rejection deep in the
// voice pipeline) in the process logs instead of letting PM2 restart the
// server with no explanation.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
  captureError(reason, { source: "unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  captureError(err, { source: "uncaughtException" });
});

// Compliance boot checks — fail fast and loud rather than silently running
// in a state the operator didn't actually confirm. Provided by @openvent/compliance.
assertHipaaPreflight();

// Config validation — logs loudly (doesn't crash) if the active providers are
// missing required keys, so the gap is visible at boot instead of only
// surfacing mid-call.
assertVoiceConfig();

// GDPR: automatic retention purge — runs on boot and then daily. No manual
// cleanup step required. Provided by @openvent/compliance.
startRetentionSweep(callLogAdapter, {
  onPurge: (result) => console.log(`[gdpr] retention sweep purged ${result.callsDeleted} expired call(s)`),
  onError: (err) => console.error("[gdpr] retention sweep failed", err),
});

// Workflows: executes due scheduled retry calls automatically (see
// workflows/scheduler.ts).
startScheduledCallSweep();

// Webhook outbox: delivers queued webhook events with retry + exponential backoff.
import { processWebhookOutbox } from "./voice/webhooks";
const WEBHOOK_SWEEP_INTERVAL_MS = 8_000;
setInterval(() => {
  void processWebhookOutbox().catch((err) =>
    console.error("[webhook-outbox] delivery sweep failed", err),
  );
}, WEBHOOK_SWEEP_INTERVAL_MS);
void processWebhookOutbox().catch(() => {});

// Seed default agent templates from prompt copy files
import { seedAgentTemplates, seedWorkflowTemplates } from "./database/seed";
void seedAgentTemplates().catch((err) => console.error("[server] seeding templates failed:", err));
void seedWorkflowTemplates().catch((err) => console.error("[server] seeding workflow templates failed:", err));

const port = Number(process.env.PORT ?? 3000);
// Single-deploy mode: serve the frontend's built assets from the sibling
// web package (monorepo layout — ADR-036). In the split deploy (Vercel
// frontend + Railway API) this dist never exists and every non-/api request
// falls through to the "build output not found" response, which is fine:
// nothing but Twilio and the dashboard should be talking to this origin.
const distDir = `${import.meta.dir}/../../web/dist`;
const indexPath = `${distDir}/index.html`;

const server = Bun.serve({
  port,
  // Bun.serve takes exactly one `websocket` handler object for the whole
  // server — every upgraded socket (Twilio Media Stream, the Preview
  // drawer's live test call, waitlist live count) shares this one,
  // dispatched by `ws.data.kind` (see voice/ws-route.ts and
  // app/waitlist-ws.ts for how each tags its data). `voiceWebsocketHandlers`
  // itself further discriminates "voice" vs "test-call" internally — this
  // outer gate must forward both kinds to it, or the test-call kind is
  // silently never dispatched at all (2026-07-15 bug: it wasn't, so every
  // test-call socket upgraded fine but open/message/close never ran —
  // dead air with no server-side log, no client-side error, until the
  // connection eventually got timed out from underneath it).
  websocket: {
    open(ws: { data: { kind: string } }) {
      if (ws.data.kind === "voice" || ws.data.kind === "test-call") voiceWebsocketHandlers.open(ws as never);
      else if (ws.data.kind === "waitlist") void waitlistWebsocketHandlers.open(ws as never);
    },
    message(ws: { data: { kind: string } }, message: string | Buffer) {
      if (ws.data.kind === "voice" || ws.data.kind === "test-call") voiceWebsocketHandlers.message(ws as never, message);
      else if (ws.data.kind === "waitlist") waitlistWebsocketHandlers.message();
    },
    close(ws: { data: { kind: string } }) {
      if (ws.data.kind === "voice" || ws.data.kind === "test-call") voiceWebsocketHandlers.close(ws as never);
      else if (ws.data.kind === "waitlist") waitlistWebsocketHandlers.close(ws as never);
    },
  },
  async fetch(request, srv) {
    const url = new URL(request.url);

    // tryUpgradeVoiceSocket is async since 2026-07-17 (Exotel stream auth
    // needs a DB/vault round-trip) — awaited first, then waitlist checked,
    // preserving the original "voice first" short-circuit order without
    // mixing an awaited and a sync call in one `||` expression.
    const voiceUpgraded = await tryUpgradeVoiceSocket(request, srv);
    if (voiceUpgraded || tryUpgradeWaitlistSocket(request, srv)) {
      // `upgrade()` takes over the connection; no HTTP response needed here.
      return undefined as unknown as Response;
    }

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}
