/**
 * Product-usage telemetry ingest (2026-07-31). The server half of the
 * first-party analytics pipe: validate a batch of client-emitted UI events
 * defensively and append them to `product_events`. See that table's doc in
 * schema.ts for the why (first-party, pre-pilot, few known questions).
 *
 * Design rules this module enforces:
 *  - Fire-and-forget from the client's view: ingest must never fail a user
 *    action. The route returns 2xx even when some events are dropped, and
 *    `recordEvents` swallows DB errors (telemetry is best-effort, never a
 *    hard dependency of the app).
 *  - Defensive shape validation instead of a shared runtime allowlist: the
 *    canonical event-name union lives in the web package (lib/analytics.ts)
 *    where the call sites are. Here we only guard against junk/abuse with a
 *    name regex + size caps, so the server stays decoupled from the browser
 *    bundle. Unknown-but-well-formed names are accepted on purpose — a new
 *    client event should never require a server deploy first.
 *  - orgId/userId are taken from the authenticated session by the caller and
 *    passed in — never trusted from the request body (a user can't attribute
 *    events to another org by construction).
 */
import { db } from "../database";
import { productEvents } from "../database/schema";

/** Max events accepted in a single POST /events batch. */
export const MAX_EVENTS_PER_BATCH = 50;
/** Lowercase snake_case, 3-64 chars, must start with a letter. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
/** Per-event cap on the JSON-serialized `props` payload. */
export const MAX_PROPS_BYTES = 4096;
/** Cap on sessionId / path string length (defensive against junk). */
const MAX_STRING_LEN = 256;

/** A validated, insert-ready event row (minus orgId/userId, added by caller). */
export type CleanEvent = {
  name: string;
  props: Record<string, unknown> | null;
  sessionId: string | null;
  path: string | null;
  occurredAt: Date | null;
};

export type ParseResult = {
  /** Well-formed events, capped at MAX_EVENTS_PER_BATCH. */
  valid: CleanEvent[];
  /** How many entries were dropped for being malformed / over the cap. */
  rejected: number;
};

function cleanString(v: unknown, max = MAX_STRING_LEN): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function cleanProps(v: unknown): Record<string, unknown> | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    const json = JSON.stringify(v);
    if (json.length > MAX_PROPS_BYTES) return null;
    return v as Record<string, unknown>;
  } catch {
    return null; // circular / non-serializable
  }
}

function cleanOccurredAt(v: unknown): Date | null {
  // Client sends epoch ms. Reject anything not a finite number or wildly out
  // of range (clock skew / junk) so a bad clock can't poison time-series.
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const now = Date.now();
  // Allow a little future skew (2 min) and up to ~1h of batching lag.
  if (t > now + 2 * 60_000 || t < now - 60 * 60_000) return null;
  return d;
}

/**
 * Validate a raw request body into insert-ready events. Pure — no I/O — so it
 * unit-tests without a DB. Accepts either `{ events: [...] }` or a bare array.
 */
export function parseEventBatch(body: unknown): ParseResult {
  const rawList: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events)
      : [];

  let rejected = 0;
  const valid: CleanEvent[] = [];

  for (const raw of rawList) {
    if (valid.length >= MAX_EVENTS_PER_BATCH) {
      rejected++;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      rejected++;
      continue;
    }
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!EVENT_NAME_RE.test(name)) {
      rejected++;
      continue;
    }
    valid.push({
      name,
      props: cleanProps(e.props),
      sessionId: cleanString(e.sessionId),
      path: cleanString(e.path),
      occurredAt: cleanOccurredAt(e.ts ?? e.occurredAt),
    });
  }

  return { valid, rejected };
}

/**
 * Append validated events for one org. Best-effort: a DB failure is logged and
 * swallowed (returns 0) — telemetry never breaks the caller. Returns the count
 * attempted (not a per-row ack; the batch insert is all-or-nothing).
 */
export async function recordEvents(
  orgId: string,
  userId: string | null,
  events: CleanEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  try {
    await db.insert(productEvents).values(
      events.map((e) => ({
        orgId,
        userId: userId ?? undefined,
        name: e.name,
        props: e.props ?? undefined,
        sessionId: e.sessionId ?? undefined,
        path: e.path ?? undefined,
        occurredAt: e.occurredAt ?? undefined,
      })),
    );
    return events.length;
  } catch (err) {
    console.error("[events-ingest] insert failed", err);
    return 0;
  }
}
