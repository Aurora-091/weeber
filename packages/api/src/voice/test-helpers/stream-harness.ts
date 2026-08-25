/**
 * Shared mock infrastructure for `stream-*.test.ts` files.
 *
 * Every `stream-*.test.ts` (22 of them as of 2026-08-25) drives the real
 * `createVoiceStreamHandlers` state machine through `mock.module` — Bun's
 * per-file, `--isolate`d module mocking, which means each test file DOES
 * still have to call `mock.module(...)` itself, at its own top level, before
 * `await import("./stream")`. That constraint can't be hidden inside a
 * helper function call (mock.module has to run before the import, so the
 * registration itself can't be deferred into a setup() call inside a test).
 *
 * What CAN be shared — and, until this file existed, was instead being
 * hand-copied into every new stream-*.test.ts, drifting slightly each time
 * (see `chain()`'s three different accumulated signatures across
 * stream-hangup.test.ts, stream-guardrail-replay.test.ts, and everywhere
 * else, before this file existed) — is the actual mock IMPLEMENTATION each
 * `mock.module(...)` call registers. A test file now does:
 *
 * ```ts
 * import { mock } from "bun:test";
 * import { createDbHarness, createSttHarness, createTtsHarness,
 *          twilioClientHarnessModule, createOrgQueriesHarness,
 *          leadsHarnessModule, fakeWs, settle, buildStartEvent } from "./test-helpers/stream-harness";
 *
 * const db = createDbHarness();
 * const stt = createSttHarness();
 * const orgQueries = createOrgQueriesHarness();
 *
 * mock.module("../database", db.module);
 * mock.module("./stt", stt.module);
 * mock.module("./tts", createTtsHarness().module);
 * mock.module("./twilio-client", twilioClientHarnessModule);
 * mock.module("./org-queries", orgQueries.module);
 * mock.module("./leads/leads", leadsHarnessModule);
 * mock.module("./agent", () => ({ ...scenario-specific, still per-file... }));
 *
 * const { createVoiceStreamHandlers } = await import("./stream");
 * ```
 *
 * `./agent`'s mock is deliberately NOT provided here — it's the one piece
 * that IS the actual test scenario in every file (which tool fires, what it
 * returns, what the greeting says), never boilerplate.
 *
 * A file whose whole point is testing STT/TTS/db internals (voice-identity
 * failover, insert-capture ordering, multi-table selects) should keep its
 * own custom mock for exactly that piece and use the harness for the rest —
 * these factories are individually importable, not an all-or-nothing bundle.
 */

// ---------------------------------------------------------------------------
// Drizzle chain stub
// ---------------------------------------------------------------------------

export type ChainHooks = {
  /** Called with whatever an update's `.set(...)` was given. */
  onSet?: (values: Record<string, unknown>) => void;
  /** Called with whatever an insert's `.values(...)` was given. */
  onValues?: (values: Record<string, unknown>) => void;
};

/**
 * A thenable that also answers every drizzle query-builder method tests
 * exercise here (`where`/`limit`/`orderBy`/`returning`/`onConflictDoNothing`/
 * `onConflictDoUpdate`/`from`) by returning itself again, plus `.set()`/
 * `.values()` hooks for tests that need to observe what an update/insert
 * actually wrote. Consolidates the three signatures that had independently
 * accumulated across stream-hangup.test.ts (rows, onValues) and
 * stream-guardrail-replay.test.ts (rows, onValues, onInsert) before this
 * file existed — every prior caller's behavior is reachable via `hooks`.
 */
export function chain(rows: unknown[], hooks: ChainHooks = {}): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "orderBy", "returning", "onConflictDoNothing", "onConflictDoUpdate", "from"]) {
    p[method] = () => chain(rows, hooks);
  }
  p.set = (values: Record<string, unknown>) => {
    hooks.onSet?.(values);
    return chain(rows, hooks);
  };
  p.values = (values: Record<string, unknown>) => {
    hooks.onValues?.(values);
    return chain(rows, hooks);
  };
  return p;
}

/** drizzle-orm table objects carry their real name only on a Symbol property. */
export function getTableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

// ---------------------------------------------------------------------------
// `../database` (db / dbBackground)
// ---------------------------------------------------------------------------

export const DEFAULT_CALL_ROW: Record<string, unknown> = {
  id: 1,
  orgId: "org_test",
  direction: "inbound",
  status: "in-progress",
};

export type DbHarnessOptions = {
  /** Table name -> seed rows returned by `select().from(table)`. Defaults to `{ calls: [DEFAULT_CALL_ROW] }`. */
  tables?: Record<string, unknown[]>;
  /** Fires on every `update(table).set(values)`, across every table. */
  onUpdate?: (table: string, values: Record<string, unknown>) => void;
  /** Fires on every `insert(table).values(values)`, across every table. */
  onInsert?: (table: string, values: Record<string, unknown>) => void;
};

/**
 * `getEffectiveFlags` (org-queries.ts) and a handful of other call sites
 * import BOTH `db` and `dbBackground` from `../database` — both must resolve
 * to something, so `module()` always returns both bound to the same stub.
 */
export function createDbHarness(options: DbHarnessOptions = {}) {
  const tables = options.tables ?? { calls: [DEFAULT_CALL_ROW] };
  const dbLike = {
    select: () => ({
      from: (table: unknown) => chain(tables[getTableName(table)] ?? []),
    }),
    // Seeded with `{ id: 1 }` (not `[]`) — stream.ts's real transcript-insert
    // path does `const [inserted] = await db.insert(transcripts).values(...)
    // .returning({ id: transcripts.id })` and reads `inserted.id`. Guarded
    // (`if (role === "caller" && inserted) ...`) so an empty return never
    // throws, but a caller-role transcript would silently never learn its
    // own id — this default keeps that path realistic for every migrated
    // test, not just the ones that happened to seed it themselves before.
    insert: (table: unknown) => {
      const name = getTableName(table);
      return chain([{ id: 1 }], { onValues: (values) => options.onInsert?.(name, values) });
    },
    update: (table: unknown) => {
      const name = getTableName(table);
      return chain([], { onSet: (values) => options.onUpdate?.(name, values) });
    },
    execute: async () => [],
  };
  return {
    dbLike,
    module: () => ({ db: dbLike, dbBackground: dbLike }),
  };
}

// ---------------------------------------------------------------------------
// `./stt`
// ---------------------------------------------------------------------------

export type TranscriptEvent = { text: string; isFinal: boolean; speechFinal: boolean; endpointSignal?: unknown };
export type OnTranscript = (event: TranscriptEvent) => void;

export function createSttHarness() {
  let lastOnTranscript: OnTranscript | null = null;
  return {
    module: () => ({
      connectStt: (onTranscript: OnTranscript) => {
        lastOnTranscript = onTranscript;
        return { sendAudio: () => {}, getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }), close: () => {} };
      },
      resolveSttProvider: (override?: string | null) => override ?? "deepgram",
    }),
    getLastOnTranscript: () => lastOnTranscript,
    reset: () => {
      lastOnTranscript = null;
    },
  };
}

// ---------------------------------------------------------------------------
// `./tts` — the "vanilla" always-succeeds mock most files use. A file whose
// own scenario IS TTS behavior (failover, voice identity, session reuse)
// should keep its own custom mock instead of this one.
// ---------------------------------------------------------------------------

export function createTtsHarness() {
  return {
    module: () => ({
      connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
        sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
        endTurn: () => onDone?.(),
        close: () => {},
      }),
      connectTtsSession: (
        providerOverride?: string | null,
        _voiceId?: string,
        _language?: string,
        onConnected?: (ms: number) => void,
      ) => {
        onConnected?.(0);
        return {
          provider: providerOverride ?? "cartesia",
          session: {
            startTurn: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
              sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
              endTurn: () => onDone?.(),
              close: () => {},
            }),
            isOpen: () => true,
            close: () => {},
          },
        };
      },
      resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
    }),
  };
}

// ---------------------------------------------------------------------------
// `./twilio-client` — stateless in every file that isn't specifically
// testing a Twilio-client failure, so this is a plain factory, not a
// harness-with-state like the ones above.
// ---------------------------------------------------------------------------

export function twilioClientHarnessModule() {
  return {
    twilioClient: {},
    getWsUrl: () => "wss://api.weeber.test",
    getPublicUrl: () => "https://api.weeber.test",
    getTwilioClientForOrg: async () => ({ calls: () => ({ update: async () => ({}) }) }),
  };
}

// ---------------------------------------------------------------------------
// `./org-queries`
// ---------------------------------------------------------------------------

export function createOrgQueriesHarness(initialFlags: Record<string, boolean> = {}) {
  let flags: Record<string, boolean> = initialFlags;
  return {
    module: () => ({ getEffectiveFlags: async () => flags }),
    setFlags: (next: Record<string, boolean>) => {
      flags = next;
    },
    reset: () => {
      flags = initialFlags;
    },
  };
}

// ---------------------------------------------------------------------------
// `./leads/leads` — stateless everywhere it's mocked so far.
// ---------------------------------------------------------------------------

export function leadsHarnessModule() {
  return {
    promoteLeadFromCall: async () => undefined,
    getLeadGreetingContext: async () => ({}),
  };
}

// ---------------------------------------------------------------------------
// WS + timing + the "start" event
// ---------------------------------------------------------------------------

export type FakeWs = { sent: string[]; send: (data: string) => void; close: () => void };

export function fakeWs(): FakeWs {
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

export function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildStartEvent(overrides: {
  streamSid?: string;
  callSid?: string;
  from?: string;
  to?: string;
} = {}): string {
  return JSON.stringify({
    event: "start",
    start: {
      streamSid: overrides.streamSid ?? "MZ-test",
      callSid: overrides.callSid ?? "CA-test",
      customParameters: {
        from: overrides.from ?? "+919999999999",
        to: overrides.to ?? "+911111111111",
      },
    },
  });
}
