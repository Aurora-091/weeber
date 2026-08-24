import { describe, it, expect } from "bun:test";
import {
  classifyCallHealth,
  DEAD_AIR_DEGRADED_MS,
  DEAD_AIR_SILENT_MS,
  LLM_TTFT_DEGRADED_MS,
  STT_CONNECT_DEGRADED_MS,
  type CallHealthInput,
} from "./call-health";

/** A fully-healthy answered call — override individual fields per case. */
function healthyCall(overrides: Partial<CallHealthInput> = {}): CallHealthInput {
  return {
    finalStatus: "completed",
    answered: true,
    turnCount: 4,
    transcriptCount: 8,
    // Half the rows are the caller's: a genuinely two-sided conversation.
    callerTranscriptCount: 4,
    hadDisposition: true,
    sttConnectMs: 400,
    llmTtftMs: 600,
    ttsFirstByteMs: 300,
    pickupToFirstAudioMs: 900,
    sttReconnectCount: 0,
    providerFailoverCount: 0,
    hadFabricatedCapture: false,
    hadUndeliveredOutcome: false,
    ...overrides,
  };
}

describe("classifyCallHealth", () => {
  it("returns healthy for a clean answered call", () => {
    const r = classifyCallHealth(healthyCall());
    expect(r.status).toBe("healthy");
    expect(r.reasons).toEqual([]);
  });

  it("returns healthy (no reasons) for a call that never connected", () => {
    const r = classifyCallHealth(
      healthyCall({
        answered: false,
        finalStatus: "failed",
        turnCount: 0,
        transcriptCount: 0,
        hadDisposition: false,
        sttConnectMs: undefined,
        llmTtftMs: undefined,
        ttsFirstByteMs: undefined,
        pickupToFirstAudioMs: undefined,
      }),
    );
    expect(r.status).toBe("healthy");
    expect(r.reasons).toEqual([]);
  });

  it("flags silent-failure when the agent never produced audio", () => {
    const r = classifyCallHealth(
      healthyCall({
        turnCount: 0,
        transcriptCount: 0,
        hadDisposition: false,
        ttsFirstByteMs: undefined,
        pickupToFirstAudioMs: undefined,
      }),
    );
    expect(r.status).toBe("silent-failure");
    expect(r.reasons.some((x) => x.includes("never produced any audio"))).toBe(true);
  });

  it("flags silent-failure when STT never connected", () => {
    const r = classifyCallHealth(
      healthyCall({
        turnCount: 0,
        transcriptCount: 0,
        hadDisposition: false,
        sttConnectMs: undefined,
        ttsFirstByteMs: undefined,
        pickupToFirstAudioMs: undefined,
      }),
    );
    expect(r.status).toBe("silent-failure");
    expect(r.reasons.some((x) => x.includes("STT never connected"))).toBe(true);
  });

  it("flags silent-failure on excessive dead air even if audio eventually arrived", () => {
    const r = classifyCallHealth(
      healthyCall({ pickupToFirstAudioMs: DEAD_AIR_SILENT_MS + 500 }),
    );
    expect(r.status).toBe("silent-failure");
    expect(r.reasons.some((x) => x.includes("dead air"))).toBe(true);
  });

  it("flags degraded (not silent) for dead air in the degraded band", () => {
    const r = classifyCallHealth(
      healthyCall({ pickupToFirstAudioMs: DEAD_AIR_DEGRADED_MS + 100 }),
    );
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("slow first audio"))).toBe(true);
  });

  it("flags degraded for slow LLM first token", () => {
    const r = classifyCallHealth(healthyCall({ llmTtftMs: LLM_TTFT_DEGRADED_MS + 1 }));
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("slow LLM first token"))).toBe(true);
  });

  it("flags degraded for slow STT connect", () => {
    const r = classifyCallHealth(healthyCall({ sttConnectMs: STT_CONNECT_DEGRADED_MS + 1 }));
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("slow STT connect"))).toBe(true);
  });

  it("flags degraded on STT reconnects and provider failovers", () => {
    const r = classifyCallHealth(
      healthyCall({ sttReconnectCount: 2, providerFailoverCount: 1 }),
    );
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("STT reconnected 2"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("failover occurred 1"))).toBe(true);
  });

  it("flags degraded for a greeting-only call with no outcome", () => {
    const r = classifyCallHealth(
      healthyCall({ turnCount: 1, transcriptCount: 1, hadDisposition: false }),
    );
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("no conversation followed"))).toBe(true);
  });

  it("does NOT flag greeting-only when an outcome was recorded", () => {
    const r = classifyCallHealth(
      healthyCall({ turnCount: 1, transcriptCount: 2, hadDisposition: true }),
    );
    expect(r.status).toBe("healthy");
  });

  it("flags degraded when an answered call ended in a failed state", () => {
    const r = classifyCallHealth(healthyCall({ finalStatus: "failed" }));
    expect(r.status).toBe("degraded");
    expect(r.reasons.some((x) => x.includes("failed state"))).toBe(true);
  });

  it("escalates to silent-failure and still surfaces degraded color reasons", () => {
    const r = classifyCallHealth(
      healthyCall({
        turnCount: 0,
        transcriptCount: 0,
        hadDisposition: false,
        ttsFirstByteMs: undefined,
        pickupToFirstAudioMs: undefined,
        sttReconnectCount: 3,
      }),
    );
    expect(r.status).toBe("silent-failure");
    // primary silent reason present
    expect(r.reasons.some((x) => x.includes("never produced any audio"))).toBe(true);
    // degraded color reason also carried through
    expect(r.reasons.some((x) => x.includes("STT reconnected 3"))).toBe(true);
  });

  it("treats a transferred call with normal turns as healthy", () => {
    const r = classifyCallHealth(healthyCall({ finalStatus: "transferred" }));
    expect(r.status).toBe("healthy");
    expect(r.reasons).toEqual([]);
  });

  // ---- ADR-084: the caller must be evidenced, not assumed ------------------
  describe("a call the caller was never heard in is not healthy", () => {
    it("flags a one-sided call where the agent took several turns alone", () => {
      // The production shape that motivated this: agent greeted, ran three
      // turns, recorded an outcome, and every latency metric was green — but no
      // caller utterance was ever transcribed.
      const r = classifyCallHealth(
        healthyCall({ turnCount: 3, transcriptCount: 3, callerTranscriptCount: 0 }),
      );
      expect(r.status).toBe("silent-failure");
      expect(r.reasons.some((x) => x.includes("never transcribed"))).toBe(true);
    });

    it("flags a disposition recorded with no caller speech as not evidence-backed", () => {
      const r = classifyCallHealth(
        healthyCall({ turnCount: 3, transcriptCount: 3, callerTranscriptCount: 0, hadDisposition: true }),
      );
      expect(r.status).toBe("silent-failure");
      expect(r.reasons.some((x) => x.includes("not evidence-backed"))).toBe(true);
    });

    it("flags a fabricated outcome even on a short call", () => {
      // turnCount is low enough to dodge the one-sided check above, so the
      // disposition rule has to stand on its own here.
      const r = classifyCallHealth(
        healthyCall({ turnCount: 1, transcriptCount: 1, callerTranscriptCount: 0, hadDisposition: true }),
      );
      expect(r.status).toBe("silent-failure");
      expect(r.reasons.some((x) => x.includes("not evidence-backed"))).toBe(true);
    });

    it("does not flag a call that never connected", () => {
      // No live pipeline to judge — zero caller rows is expected, not a fault.
      const r = classifyCallHealth(
        healthyCall({
          answered: false,
          callerTranscriptCount: 0,
          transcriptCount: 0,
          turnCount: 0,
          hadDisposition: false,
        }),
      );
      expect(r.status).toBe("healthy");
    });

    it("does not double-flag a greeting-only call with no outcome", () => {
      // Already covered by the greeting-only degraded rule. With one turn, no
      // disposition and no caller speech, neither ADR-084 rule should fire and
      // escalate it to silent-failure.
      const r = classifyCallHealth(
        healthyCall({ turnCount: 1, transcriptCount: 1, callerTranscriptCount: 0, hadDisposition: false }),
      );
      expect(r.status).toBe("degraded");
      expect(r.reasons.some((x) => x.includes("not evidence-backed"))).toBe(false);
    });

    it("stays healthy as soon as the caller is transcribed even once", () => {
      const r = classifyCallHealth(
        healthyCall({ turnCount: 3, transcriptCount: 4, callerTranscriptCount: 1 }),
      );
      expect(r.status).toBe("healthy");
      expect(r.reasons).toEqual([]);
    });
  });

  /**
   * B5 (phase-b-measurement.md) — "the two production calls' actual numbers
   * must not classify as healthy." Both fixtures below are the real numbers,
   * pulled directly from the production database on 2026-08-24
   * (`mcp__supabase__execute_sql` against calls/call_latency/turn_latency/
   * transcripts) — the same incident `docs/audits/2026-08-21-first-two-
   * production-calls.md` describes by hand. Both rows are stored in
   * production today with `health_status = "healthy"`, `health_reasons = []`
   * — that stale verdict was computed by the pre-B5 thresholds/logic and is
   * exactly what this fixes.
   */
  describe("the two production calls that motivated this phase", () => {
    it("call 1 (2026-08-20 11:52 UTC) does not classify as healthy — undelivered crmSync", () => {
      const r = classifyCallHealth({
        finalStatus: "completed",
        answered: true,
        turnCount: 12, // turn_latency turn_index 0-11
        transcriptCount: 22,
        callerTranscriptCount: 10,
        hadDisposition: true, // setDisposition({ disposition: "no-decision", ... })
        sttConnectMs: 608,
        llmTtftMs: 1259,
        ttsFirstByteMs: 414,
        pickupToFirstAudioMs: 1985, // audit finding 7: 2.5x the 800ms bar
        sttReconnectCount: 0,
        providerFailoverCount: 0,
        maxTurnVoiceToVoiceMs: 4031, // turn_index 11
        hadFabricatedCapture: false, // the honest-capture control call — tobacco was genuinely stated
        hadUndeliveredOutcome: true, // crmSync returned { synced: false, message: "(not configured) ..." }
      });
      expect(r.status).not.toBe("healthy");
      expect(r.reasons.some((x) => x.includes("not actually delivered"))).toBe(true);
    });

    it("call 2 (2026-08-20 17:34 UTC) does not classify as healthy — fabricated capture AND undelivered outcomes", () => {
      const r = classifyCallHealth({
        finalStatus: "completed",
        answered: true,
        turnCount: 19, // turn_latency turn_index 0-18
        transcriptCount: 32,
        callerTranscriptCount: 14,
        hadDisposition: true, // setDisposition({ disposition: "callback-requested", ... })
        sttConnectMs: 753, // the audit's own named case: STT_CONNECT_DEGRADED_MS never fired on this
        llmTtftMs: 1585,
        ttsFirstByteMs: 463,
        pickupToFirstAudioMs: 2753, // audit finding 7: 3.4x the 800ms bar
        sttReconnectCount: 0,
        providerFailoverCount: 0,
        maxTurnVoiceToVoiceMs: 4846, // turn_index 18 — audit finding 3's "terminal turn is the slowest turn"
        hadFabricatedCapture: true, // audit finding 1: tobacco=no, caller never said it
        hadUndeliveredOutcome: true, // crmSync not configured AND callback-requested with no scheduled_calls row (finding 2)
      });
      expect(r.status).toBe("silent-failure"); // fabrication + undelivered outcome both land in the silent bucket
      expect(r.reasons.some((x) => x.includes("invented a fact"))).toBe(true);
      expect(r.reasons.some((x) => x.includes("not actually delivered"))).toBe(true);
    });
  });
});
