/**
 * Live waitlist-count broadcaster for the landing page — raw Bun WebSocket,
 * kept out of the Hono app for the same reason voice/ws-route.ts is: Bun's
 * `Bun.serve` only takes one `websocket` handler object for the whole
 * server, so both this and the Twilio Media Stream socket share that one
 * object in server.ts, dispatched by `data.kind` (see server.ts).
 *
 * No client -> server messages of any real meaning here — a client connects
 * purely to receive `waitlist_count` pushes whenever someone joins
 * (broadcastWaitlistCount, called from public-routes.ts after a successful
 * join) plus one on connect so the count is never blank while waiting for
 * the next signup.
 */
import { getWaitlistDisplayCount } from "./waitlist";

export const WAITLIST_WS_PATH = "/api/public/waitlist/ws";

type WaitlistSocketData = { kind: "waitlist" };
type Sendable = { send: (data: string) => void; readyState: number; data: unknown };

const clients = new Set<Sendable>();
const OPEN = 1;

export function tryUpgradeWaitlistSocket(request: Request, server: { upgrade: Function }): boolean {
  const url = new URL(request.url);
  if (url.pathname !== WAITLIST_WS_PATH) return false;
  return Boolean(server.upgrade(request, { data: { kind: "waitlist" } satisfies WaitlistSocketData }));
}

export const waitlistWebsocketHandlers = {
  async open(ws: Sendable) {
    clients.add(ws);
    try {
      const count = await getWaitlistDisplayCount();
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "waitlist_count", count }));
    } catch (err) {
      console.error("[waitlist-ws] failed to send initial count", err);
    }
  },
  message() {
    // No client messages expected — this socket is receive-only from the
    // frontend's perspective.
  },
  close(ws: Sendable) {
    clients.delete(ws);
  },
};

/** Called after every successful (non-duplicate) join — pushes the fresh
 * count to every connected landing-page tab. Best-effort: a slow/dead
 * client shouldn't block or crash the join request that triggered this. */
export async function broadcastWaitlistCount(): Promise<void> {
  try {
    const count = await getWaitlistDisplayCount();
    const payload = JSON.stringify({ type: "waitlist_count", count });
    for (const ws of clients) {
      if (ws.readyState === OPEN) ws.send(payload);
    }
  } catch (err) {
    console.error("[waitlist-ws] failed to broadcast count", err);
  }
}
