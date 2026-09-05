import { createVoiceStreamHandlers } from "./stream";
import type { TelephonyProvider } from "./telephony-transport";
import { createTestCallStreamHandlers } from "./test-call-stream";
import { consumeTestCallToken } from "./test-call-tokens";
import { verifyExotelStreamAuth } from "./middleware/exotel-auth";

/**
 * Native Bun WebSocket handling for the live-call media stream, kept out of
 * the Hono app on purpose: `hono/bun`'s upgrade helper touches the `Bun`
 * global at import time, which crashes Vite's dev SSR module runner
 * (Node-based). This module is only ever imported from `server.ts`, which
 * always runs under the real Bun runtime (`bun run start` / `bun
 * packages/web/src/server.ts`), so dev mode (`bun run dev`, Vite) never
 * loads it and stays crash-free.
 *
 * Note: these WS routes only work when the app is served by the real Bun
 * server — not via the Vite dev server. Use `bun run start` (or the
 * production preview) to test calls end-to-end.
 *
 * One path per telephony provider — each provider's inbound webhook/API
 * (see voice/routes.ts) points its `<Stream>`/`streamurl` config at the
 * matching path here, so the right wire-format adapter
 * (voice/telephony-transport.ts) is selected up front instead of sniffing
 * the first message.
 *
 * `/api/voice/test-call` is a different kind of socket entirely — not a
 * telephony provider, the Preview drawer's live voice test call (see
 * test-call-stream.ts). Auth is a short-lived one-time token (query param,
 * since browser WebSocket can't set custom headers) minted by an
 * authenticated HTTP POST — see test-call-tokens.ts.
 */
type VoiceSocketData =
  | { kind: "voice"; handlers: ReturnType<typeof createVoiceStreamHandlers> }
  | { kind: "test-call"; handlers: ReturnType<typeof createTestCallStreamHandlers> };

/**
 * Voice-pipeline hardening plan, Stage 3 (2026-09-05) — deploy draining.
 *
 * This process holds live call state entirely in memory (see stream.ts's
 * module doc comment on `createVoiceStreamHandlers`'s closure) — there is no
 * reconnect path, so a deploy that kills the process mid-call drops that
 * call to dead air. `isDraining`/`activeCallCount` are the two pieces
 * server.ts needs to stop making that worse on every deploy: refuse new
 * calls once a shutdown is requested, and know when it's actually safe to
 * exit (every in-flight call has ended on its own) rather than guessing.
 *
 * Deliberately does NOT try to migrate or resume an in-flight call — that
 * needs durable per-call state this architecture doesn't have (see the
 * plan's Stage 6, not started). This is strictly "stop the bleeding on the
 * *next* deploy," not a fix for the process dying uncontrolled.
 */
let isDraining = false;
let activeCallCount = 0;

export function beginDraining(): void {
  isDraining = true;
}

export function getActiveCallCount(): number {
  return activeCallCount;
}

const VOICE_WS_PATHS: Record<TelephonyProvider, string> = {
  twilio: "/api/voice/stream",
  plivo: "/api/voice/stream/plivo",
  exotel: "/api/voice/stream/exotel",
};

const TEST_CALL_WS_PATH = "/api/voice/test-call";

/** Kept for any existing code that only knows about the Twilio path. */

/**
 * Async since 2026-07-17 (Exotel stream auth) — every other branch here
 * resolves synchronously, but verifying an Exotel connection's Basic Auth
 * header against that org's stored Exotel API token (verifyExotelStreamAuth)
 * needs a DB/vault round-trip. See server.ts's `fetch` for the one call
 * site, already an async function.
 */
export async function tryUpgradeVoiceSocket(request: Request, server: { upgrade: Function }): Promise<boolean> {
  const url = new URL(request.url);

  // Stage 3: refuse every new call/test-call socket once a shutdown has been
  // requested — accepting one now just means dropping it seconds later when
  // the process actually exits. `false` here falls through to server.ts's
  // ordinary fetch handler, which 500s with "Build output not found" for a
  // WS-upgrade request that matches no static file; Twilio/Plivo/Exotel each
  // treat a non-101 response as the stream failing to start, same as any
  // other unreachable-media-stream failure they already have to handle.
  if (isDraining) {
    console.warn(`[voice] rejecting new WS upgrade for ${url.pathname} — server is draining for shutdown`);
    return false;
  }

  if (url.pathname === TEST_CALL_WS_PATH) {
    const token = url.searchParams.get("token");
    const payload = token ? consumeTestCallToken(token) : null;
    if (!payload) return false; // missing/expired/already-used token — reject the upgrade entirely
    const handlers = createTestCallStreamHandlers(payload);
    return Boolean(server.upgrade(request, { data: { kind: "test-call", handlers } satisfies VoiceSocketData }));
  }

  const provider = (Object.entries(VOICE_WS_PATHS).find(([, path]) => path === url.pathname)?.[0] as
    | TelephonyProvider
    | undefined);
  if (!provider) return false;

  // Exotel stream auth (2026-07-17, middleware/exotel-auth.ts) — Twilio and
  // Plivo are already guarded at their HTTP answer-webhook layer
  // (requireTwilioSignature/requirePlivoSignature in routes.ts); Exotel has
  // no such route, so this is the actual entry point that needs guarding
  // for that provider. Rejects the upgrade outright on any failure —
  // logged so a real misconfiguration (wrong token, no creds on file) is
  // visible in Railway logs rather than a silent connection drop.
  if (provider === "exotel") {
    const auth = await verifyExotelStreamAuth(request);
    if (!auth.ok) {
      console.warn(`[exotel-auth] rejected WS upgrade: ${auth.error}`);
      return false;
    }
  }

  const handlers = createVoiceStreamHandlers(provider);
  return Boolean(server.upgrade(request, { data: { kind: "voice", handlers } satisfies VoiceSocketData }));
}

export const voiceWebsocketHandlers = {
  open(ws: { send: (data: string) => void; close?: (code?: number, reason?: string) => void; data: VoiceSocketData }) {
    // Stage 3: only real telephony calls ("voice") hold up a drain wait — a
    // merchant's live test call in the Preview drawer is worth trying not to
    // drop too, but it isn't worth delaying a deploy for, so only "voice"
    // counts here even though both kinds are refused new upgrades above.
    if (ws.data.kind === "voice") activeCallCount++;
    if (ws.data.kind === "test-call") {
      void ws.data.handlers.onOpen(ws);
      return;
    }
    ws.data.handlers.onOpen();
  },
  message(ws: { data: VoiceSocketData; send: (data: string) => void; close?: (code?: number, reason?: string) => void }, message: string | Buffer) {
    const data = typeof message === "string" ? message : message.toString();
    if (ws.data.kind === "test-call") {
      ws.data.handlers.onMessage(data, ws);
      return;
    }
    void ws.data.handlers.onMessage(data, ws);
  },
  close(ws: { data: VoiceSocketData }) {
    if (ws.data.kind === "voice") activeCallCount--;
    ws.data.handlers.onClose();
  },
};
