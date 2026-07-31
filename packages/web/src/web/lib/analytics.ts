/**
 * First-party product-usage telemetry — client half of the pipe (2026-07-31).
 * Emits typed UI events to POST /api/app/events (see api/src/app/events-ingest.ts
 * and the product_events table). Replaces the dead `window.stonks` shim that was
 * declared but never wired.
 *
 * Contract this module guarantees:
 *  - `track()` NEVER throws and NEVER blocks a user action. Everything is wrapped
 *    in try/catch and the actual send is fire-and-forget (errors swallowed).
 *    Instrumentation failing must be invisible to the merchant.
 *  - Events are batched (queue + timer) and flushed opportunistically, plus a
 *    best-effort flush on tab hide / pagehide via `keepalive` fetch.
 *  - The canonical event-name list lives HERE (AppEventName). The server only
 *    validates shape defensively, so adding a new event is a client-only change.
 *
 * Scope for v1: the workflow canvas / Customize flow (the black box we're lighting
 * up). Add names to AppEventName as new surfaces get instrumented.
 */
import { apiUrl } from "./api";
import { userHeaders } from "./user-session";

/**
 * Canonical product event names. Keep snake_case, lowercase, <=64 chars
 * (server regex: /^[a-z][a-z0-9_]{2,63}$/). Each event exists to answer a
 * specific question about the canvas/Customize flow — don't add noise.
 */
export type AppEventName =
  // Activation funnel
  | "workflow_list_viewed" // { vertical, templateCount }
  | "workflow_customize_started" // { templateKey, source: "template" | "blank" | "ai_draft" | "reopen" }
  | "workflow_save_attempted" // { templateKey, nodeCount, edgeCount }
  | "workflow_save_blocked" // { templateKey, issueCodes: string[], errors, blockers }
  | "workflow_save_succeeded" // { templateKey, activated: boolean, warnings: string[], msSinceStart? }
  | "workflow_activated" // { templateKey }
  | "workflow_paused" // { templateKey }
  // Is the canvas actually used as a canvas?
  | "workflow_node_added" // { nodeType }
  | "workflow_node_deleted" // { nodeType }
  | "workflow_edge_connected" // {}
  | "workflow_node_config_opened" // { nodeType }
  // AI-draft door
  | "workflow_ai_draft_requested" // { templateKey, promptLen }
  | "workflow_ai_draft_succeeded" // { templateKey, nodeCount }
  | "workflow_ai_draft_failed"; // { templateKey, reason }

type QueuedEvent = {
  name: AppEventName;
  props?: Record<string, unknown>;
  sessionId: string;
  path: string;
  ts: number;
};

const FLUSH_INTERVAL_MS = 4000;
const MAX_BATCH = 25;
const SID_KEY = "weeber_sid";

const isBrowser = typeof window !== "undefined";

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
// Last-known auth header, kept in sync on every async flush so the synchronous
// hide/pagehide path can send with `keepalive` without awaiting getSession()
// (which may not resolve before the page unloads).
let cachedAuthHeader: Record<string, string> = {};

function getSessionId(): string {
  if (!isBrowser) return "ssr";
  try {
    let sid = sessionStorage.getItem(SID_KEY);
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return "nostorage";
  }
}

function sendBatch(events: QueuedEvent[], headers: Record<string, string>, keepalive: boolean): void {
  if (events.length === 0) return;
  try {
    void fetch(apiUrl("/api/app/events"), {
      method: "POST",
      keepalive,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ events }),
    }).catch(() => {
      // best-effort — drop on failure, never surface to the user
    });
  } catch {
    // fetch itself threw (unsupported keepalive size, etc.) — drop silently
  }
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    const headers = await userHeaders();
    cachedAuthHeader = headers;
    sendBatch(batch, headers, true);
  } catch {
    // couldn't resolve auth — drop this batch, keep the app happy
  }
  // If more piled up past the batch cap, keep draining.
  if (queue.length > 0) scheduleFlush();
}

function scheduleFlush(): void {
  if (timer || !isBrowser) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

function flushOnHide(): void {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  sendBatch(batch, cachedAuthHeader, true);
}

/**
 * Record a product event. Safe to call from anywhere in the merchant app —
 * never throws, never blocks. Fire it and move on.
 */
export function track(name: AppEventName, props?: Record<string, unknown>): void {
  if (!isBrowser) return;
  try {
    queue.push({
      name,
      props,
      sessionId: getSessionId(),
      path: window.location.pathname,
      ts: Date.now(),
    });
    if (queue.length >= MAX_BATCH) void flush();
    else scheduleFlush();
  } catch {
    // never let instrumentation break a user action
  }
}

if (isBrowser) {
  // Warm the cached auth header so the first hide-flush can authenticate.
  void userHeaders()
    .then((h) => {
      cachedAuthHeader = h;
    })
    .catch(() => {});

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  window.addEventListener("pagehide", flushOnHide);
}
