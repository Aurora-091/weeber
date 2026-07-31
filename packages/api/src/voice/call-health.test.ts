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
    hadDisposition: true,
    sttConnectMs: 400,
    llmTtftMs: 600,
    ttsFirstByteMs: 300,
    pickupToFirstAudioMs: 900,
    sttReconnectCount: 0,
    providerFailoverCount: 0,
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
});
