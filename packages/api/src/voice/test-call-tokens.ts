/**
 * Short-lived, single-use tokens for the Preview drawer's live voice test
 * call (AGENT-CONSOLE-UI-PLAN.md Phase 2). A browser WebSocket can't send
 * custom headers, so the user/admin session auth that gates every other
 * /api/app and /api/voice route can't gate the WS upgrade directly. Instead:
 *
 *   1. An authenticated HTTP POST (real session/admin-key check, same as
 *      test-chat) issues a random opaque token bound to exactly
 *      { orgId, templateKey, configOverride } and a short TTL.
 *   2. The browser opens the WS with that token as a query param.
 *   3. The WS upgrade handler (ws-route.ts) looks the token up here,
 *      consumes it (single-use — deleted on lookup whether valid or not,
 *      so a captured/replayed token from a log doesn't grant a second
 *      session), and rejects the upgrade if missing/expired.
 *
 * In-memory, process-local — consistent with fixed-window-limiter.ts and
 * session-store.ts's existing tradeoffs for a single-instance deployment.
 * Never persisted: these are single-call, throwaway credentials, not
 * something that needs to survive a restart or be queryable later.
 */
import { randomBytes } from "node:crypto";
import type { AgentFrame } from "./agent-frame";

export type TestCallTokenPayload = {
  orgId: string;
  templateKey: string;
  configOverride?: AgentFrame;
  /** Who to attribute this test call to in logs — user org id or the admin actor string. */
  actor: string;
};

const TOKEN_TTL_MS = 2 * 60_000;
const tokens = new Map<string, { payload: TestCallTokenPayload; expiresAt: number }>();

function sweepExpired() {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

export function issueTestCallToken(payload: TestCallTokenPayload): string {
  sweepExpired();
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { payload, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/** Single-use: always deletes the entry, valid or not. Returns null if missing/expired. */
export function consumeTestCallToken(token: string): TestCallTokenPayload | null {
  const entry = tokens.get(token);
  tokens.delete(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) return null;
  return entry.payload;
}
