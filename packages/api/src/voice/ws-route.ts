import { createVoiceStreamHandlers } from "./stream";

/**
 * Native Bun WebSocket handling for the Twilio Media Stream, kept out of the
 * Hono app on purpose: `hono/bun`'s upgrade helper touches the `Bun` global at
 * import time, which crashes Vite's dev SSR module runner (Node-based). This
 * module is only ever imported from `server.ts`, which always runs under the
 * real Bun runtime (`bun run start` / `bun packages/web/src/server.ts`), so
 * dev mode (`bun run dev`, Vite) never loads it and stays crash-free.
 *
 * Note: the Twilio Media Stream WS route only works when the app is served by
 * the real Bun server — not via the Vite dev server. Use `bun run start` (or
 * the production preview) to test calls end-to-end.
 */
type VoiceSocketData = { handlers: ReturnType<typeof createVoiceStreamHandlers> };

export const VOICE_WS_PATH = "/api/voice/stream";

export function tryUpgradeVoiceSocket(request: Request, server: { upgrade: Function }): boolean {
  const url = new URL(request.url);
  if (url.pathname !== VOICE_WS_PATH) return false;

  const handlers = createVoiceStreamHandlers();
  return Boolean(server.upgrade(request, { data: { handlers } satisfies VoiceSocketData }));
}

export const voiceWebsocketHandlers = {
  open(ws: { send: (data: string) => void; data: VoiceSocketData }) {
    ws.data.handlers.onOpen(ws);
  },
  message(ws: { data: VoiceSocketData; send: (data: string) => void }, message: string | Buffer) {
    const data = typeof message === "string" ? message : message.toString();
    void ws.data.handlers.onMessage(data, ws);
  },
  close(ws: { data: VoiceSocketData }) {
    ws.data.handlers.onClose();
  },
};
