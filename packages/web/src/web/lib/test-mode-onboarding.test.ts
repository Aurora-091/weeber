import { describe, it, expect } from "bun:test";
import { resolveTestModeState, shouldPostTestMode, summarizeTestMode } from "./test-mode-onboarding";

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

describe("resolveTestModeState", () => {
  it("treats a future timestamp as an active bypass", () => {
    const s = resolveTestModeState(new Date(NOW + 3_600_000).toISOString(), NOW);
    expect(s.active).toBe(true);
    expect(s.expired).toBe(false);
  });

  it("treats a past timestamp as expired, not as never-configured", () => {
    const s = resolveTestModeState(new Date(NOW - 1_000).toISOString(), NOW);
    expect(s.active).toBe(false);
    expect(s.expired).toBe(true);
    expect(s.until).not.toBeNull();
  });

  it("distinguishes never-configured from expired", () => {
    expect(resolveTestModeState(null, NOW)).toEqual({ active: false, expired: false, until: null });
    expect(resolveTestModeState(undefined, NOW).expired).toBe(false);
  });

  it("does not report a garbage timestamp as expired", () => {
    // An unparseable value is bad data, not evidence of a past demo — reporting
    // it as expired would make ADR-108's hint blame a window that never existed.
    const s = resolveTestModeState("not-a-date", NOW);
    expect(s).toEqual({ active: false, expired: false, until: null });
  });
});

describe("shouldPostTestMode", () => {
  const never = resolveTestModeState(null, NOW);
  const activeState = resolveTestModeState(new Date(NOW + 3_600_000).toISOString(), NOW);
  const expiredState = resolveTestModeState(new Date(NOW - 3_600_000).toISOString(), NOW);

  it('always posts for "testing" — that is what arms the window', () => {
    expect(shouldPostTestMode("testing", never)).toBe(true);
    expect(shouldPostTestMode("testing", activeState)).toBe(true);
    expect(shouldPostTestMode("testing", expiredState)).toBe(true);
  });

  it('does not post "no" for an org that never had test mode on', () => {
    expect(shouldPostTestMode("real-customers", never)).toBe(false);
  });

  it('revokes an active window when the answer is "real customers"', () => {
    expect(shouldPostTestMode("real-customers", activeState)).toBe(true);
  });

  it("leaves an already-expired timestamp alone", () => {
    // Clearing it would erase the evidence ADR-108's lapsed-window hint reads
    // to explain a refusal.
    expect(shouldPostTestMode("real-customers", expiredState)).toBe(false);
  });
});

describe("summarizeTestMode", () => {
  it("never claims compliance is off, and names what still applies", () => {
    const active = summarizeTestMode(resolveTestModeState(new Date(NOW + 1000).toISOString(), NOW));
    expect(active).toContain("DNC");
    expect(active.toLowerCase()).not.toContain("compliance off");
  });

  it("distinguishes lapsed from never-on", () => {
    const lapsed = summarizeTestMode(resolveTestModeState(new Date(NOW - 1000).toISOString(), NOW));
    const never = summarizeTestMode(resolveTestModeState(null, NOW));
    expect(lapsed).not.toBe(never);
    expect(lapsed).toContain("lapsed");
  });
});
