/**
 * Registry of active/pending call sessions, keyed by Twilio CallSid. Lets the
 * outbound-call trigger pass a custom persona/context into the WebSocket
 * stream handler once Twilio connects the media stream for that call.
 *
 * Two backends (ADR-026):
 *   - In-memory (default) — process-local, zero config, exactly today's
 *     behavior. Fine for a single instance.
 *   - Redis-backed — opt-in via `REDIS_URL`, needed only if you run more
 *     than one instance and need session state shared across them.
 *
 * The interface is async either way (even the in-memory implementation),
 * so switching backends is a config change, not a code change anywhere that
 * calls this module.
 */
import type { ResolvedAgentConfig } from "./agent";
import type { CapturedField } from "../database/schema";

export type CallSession = {
  callSid: string;
  direction: "inbound" | "outbound";
  persona?: string;
  dbCallId?: number;
  webhookUrl?: string;
  createdAt: number;
  /** Per-call overrides — let a single call use a different provider than the global default. */
  ttsProvider?: "elevenlabs" | "cartesia" | "sarvam";
  llmProvider?: "gateway" | "groq";
  /** STT provider + language override for this call — see agent-frame.ts. */
  sttProvider?: "deepgram" | "sarvam";
  language?: string;
  maxDurationSeconds?: number;
  /** Set when this call was placed by the workflow scheduler (a retry) — lets the
   * workflow engine enforce maxRetries instead of retrying forever. */
  workflowName?: string;
  workflowAttempt?: number;
  /**
   * Weeber org-lite scoping + vertical workflow context (additive) — see
   * ADR-030. Carried from `scheduledCalls.orgId`/`.metadata` through the
   * session so a retry (via the workflow engine's "retry" action) can
   * carry the same context forward instead of losing it on the next hop
   * (e.g. the Shopify COD-confirmation workflow needs `shop`/`orderId` on
   * every retry attempt, not just the first call).
   */
  orgId?: string;
  checkoutToken?: string | null;
  workflowMetadata?: Record<string, string | number>;
  /** Graph-engine workflow run ID — when set, call-end routes to
   * `resumeWorkflowAfterCall` instead of the legacy `runWorkflowForOutcome`. */
  workflowRunId?: string;
  /**
   * Structured, deterministic call state — facts captured via the
   * `captureField` tool during this call (email, order ID, name, etc).
   * This is read back into the system prompt every turn as ground truth
   * (see agent.ts) and persisted to `calls.capturedState` on each update
   * and at call end. Mirrors, and is the in-memory source of truth for,
   * the DB column — see ADR-012.
   */
  capturedState?: Record<string, CapturedField>;
  /**
   * Misc-1: the Agent Preview's "call my phone" test call passes the
   * merchant's *unsaved, in-progress* form edits (persona, voice, tools —
   * everything `buildPreviewAgentConfig`/the WS test call already preview)
   * straight through, bypassing `orgAgentConfigs` entirely for this one
   * real PSTN call — see place-outbound-call.ts's test-call-phone route and
   * stream.ts's use of this field, which short-circuits `resolveAgentConfig`
   * when present so the call reflects the exact form state, not what's
   * saved in the DB.
   */
  resolvedConfigOverride?: ResolvedAgentConfig;
};

export type SessionStore = {
  set(callSid: string, session: Omit<CallSession, "createdAt">): Promise<void>;
  get(callSid: string): Promise<CallSession | undefined>;
  update(callSid: string, patch: Partial<CallSession>): Promise<void>;
  delete(callSid: string): Promise<void>;
  /** Best-effort diagnostic count, not meant for hot-path logic — on the Redis
   * backend this is an O(n) key scan, not a cheap counter. */
  size(): Promise<number>;
};

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes (in-memory backend only)

class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, CallSession>();

  constructor() {
    // Only run the sweep under the real server process, not during typecheck/build/tests.
    if (typeof setInterval !== "undefined") {
      setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref?.();
    }
  }

  async set(callSid: string, session: Omit<CallSession, "createdAt">) {
    this.sessions.set(callSid, { ...session, createdAt: Date.now() });
  }

  async get(callSid: string) {
    return this.sessions.get(callSid);
  }

  async update(callSid: string, patch: Partial<CallSession>) {
    const existing = this.sessions.get(callSid);
    if (existing) this.sessions.set(callSid, { ...existing, ...patch });
  }

  async delete(callSid: string) {
    this.sessions.delete(callSid);
  }

  async size() {
    return this.sessions.size;
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [callSid, session] of this.sessions) {
      if (session.createdAt < cutoff) {
        console.warn(`[session-store] dropping stale session for ${callSid} (age > 1h)`);
        this.sessions.delete(callSid);
      }
    }
  }
}

/**
 * Redis-backed implementation — one JSON-serialized value per key, native
 * TTL expiry instead of the in-memory backend's manual sweep interval.
 * Lazily constructs the ioredis client so importing this module never
 * requires `ioredis` to be reachable unless `REDIS_URL` is actually set.
 */
class RedisSessionStore implements SessionStore {
  private client: import("ioredis").Redis;
  // Safe to rename right now precisely because REDIS_URL is unset in
  // production — createSessionStore() is returning MemorySessionStore, so there
  // is no live keyspace to orphan. If Redis is ever switched on, changing this
  // prefix again mid-flight strands every in-progress call's session under the
  // old prefix: get() misses, the agent loses its captured fields, and size()
  // under-reports. At that point this needs a read-both/write-new migration,
  // not an edit.
  private keyPrefix = "weeber:session:";

  constructor(redisUrl: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis") as typeof import("ioredis");
    this.client = new Redis.default(redisUrl, { lazyConnect: false });
    this.client.on("error", (err: unknown) => console.error("[session-store] Redis error", err));
  }

  private key(callSid: string) {
    return `${this.keyPrefix}${callSid}`;
  }

  async set(callSid: string, session: Omit<CallSession, "createdAt">) {
    const full: CallSession = { ...session, createdAt: Date.now() };
    await this.client.set(this.key(callSid), JSON.stringify(full), "PX", SESSION_TTL_MS);
  }

  async get(callSid: string) {
    const raw = await this.client.get(this.key(callSid));
    return raw ? (JSON.parse(raw) as CallSession) : undefined;
  }

  async update(callSid: string, patch: Partial<CallSession>) {
    const existing = await this.get(callSid);
    if (!existing) return;
    const merged = { ...existing, ...patch };
    // Preserve remaining TTL rather than resetting the full hour on every
    // small patch (e.g. a captureField update mid-call).
    const ttl = await this.client.pttl(this.key(callSid));
    await this.client.set(this.key(callSid), JSON.stringify(merged), "PX", ttl > 0 ? ttl : SESSION_TTL_MS);
  }

  async delete(callSid: string) {
    await this.client.del(this.key(callSid));
  }

  async size() {
    const keys = await this.client.keys(`${this.keyPrefix}*`);
    return keys.length;
  }
}

function createSessionStore(): SessionStore {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    console.log("[session-store] REDIS_URL set — using Redis-backed session storage");
    return new RedisSessionStore(redisUrl);
  }
  return new MemorySessionStore();
}

export const sessionStore: SessionStore = createSessionStore();
