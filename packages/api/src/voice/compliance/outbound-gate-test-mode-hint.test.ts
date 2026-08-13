import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Regression tests for the expired-test-mode diagnosis appended to a refusal
 * reason (2026-08-12).
 *
 * The defect: `orgs.callingWindowTestModeUntil` is deliberately self-expiring
 * (24h), and on expiry the refusal it produces is byte-identical to the refusal
 * an org that was never configured gets. During a live demo that meant reading a
 * TRAI 1600-series registration requirement out loud when the actual remedy was
 * one toggle on the Settings page.
 *
 * The two properties that matter here are not "does the string appear" but:
 *   1. the hint appears ONLY for gates test mode actually lifts, so it can never
 *      imply that DNC or the FTSA attempt cap is bypassable, and
 *   2. the original regulatory reason survives verbatim — the hint is additive,
 *      because the registration requirement is still real after the toggle.
 */

let orgRows: Array<{ callingWindowTestModeUntil: Date | null }> = [];

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(orgRows) }),
      }),
    }),
  },
}));

mock.module("../../database/schema", () => ({
  orgs: { id: { name: "id" }, callingWindowTestModeUntil: { name: "calling_window_test_mode_until" } },
}));

mock.module("drizzle-orm", () => ({ eq: () => true, and: () => true }));

// Every gate allows by default; each test flips exactly the one it is about, so a
// refusal can be attributed to a specific gate with no ambiguity.
let dncHit = false;
let attemptCapAllowed = true;
let numberSeriesAllowed = true;

const NUMBER_SERIES_REASON =
  "This org is insurance-vertical and calling an India number, but has no active phone number " +
  "registered as TRAI 1600-series — required for IRDAI-regulated service/transactional calls.";

mock.module("@weeber/compliance", () => ({
  isOnDoNotCallList: () => Promise.resolve(dncHit),
  checkCallingWindow: () => ({ allowed: true, reason: "ok", resolvedTimezone: null, localHour: 12 }),
}));

mock.module("./adapters", () => ({ dncAdapter: {} }));

mock.module("./attempt-cap", () => ({
  checkFtsaAttemptCap: () =>
    Promise.resolve(
      attemptCapAllowed
        ? { allowed: true }
        : { allowed: false, reason: "Florida FTSA cap reached — 3 calls already placed to this number in the last 24h (max 3)." },
    ),
}));

mock.module("./insurance-gates", () => ({
  checkInsuranceNumberSeriesCompliance: () =>
    Promise.resolve(numberSeriesAllowed ? { allowed: true } : { allowed: false, reason: NUMBER_SERIES_REASON }),
  checkInsuranceProducerLicensing: () => Promise.resolve({ allowed: true }),
}));

mock.module("./number-series-gate", () => ({
  checkIndiaNumberSeriesCompliance: () => Promise.resolve({ allowed: true }),
}));

const { assertOutboundCallAllowed } = await import("./outbound-gate");

const HOUR = 60 * 60 * 1000;
const expiredHoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

describe("expired test mode is named in the refusal", () => {
  beforeEach(() => {
    orgRows = [];
    dncHit = false;
    attemptCapAllowed = true;
    numberSeriesAllowed = true;
  });

  it("appends the diagnosis when a bypassable gate refuses and test mode has lapsed", async () => {
    orgRows = [{ callingWindowTestModeUntil: expiredHoursAgo(3) }];
    numberSeriesAllowed = false;

    const result = await assertOutboundCallAllowed("org-1", "+919876543210");

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("insurance_number_series");
    expect(result.reason).toContain("demo/test mode expired");
    expect(result.reason).toContain("3 hours ago");
    expect(result.reason).toContain("Settings page");
    // Additive, not a replacement — the real requirement still has to be stated.
    expect(result.reason).toContain("TRAI 1600-series");
  });

  it("stays silent when test mode was never enabled (no demo history to blame)", async () => {
    orgRows = [{ callingWindowTestModeUntil: null }];
    numberSeriesAllowed = false;

    const result = await assertOutboundCallAllowed("org-1", "+919876543210");

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe(NUMBER_SERIES_REASON);
  });

  it("never implies DNC is bypassable, even with test mode freshly expired", async () => {
    orgRows = [{ callingWindowTestModeUntil: expiredHoursAgo(1) }];
    dncHit = true;

    const result = await assertOutboundCallAllowed("org-1", "+919876543210");

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("dnc");
    expect(result.reason).not.toContain("test mode");
    expect(result.reason).not.toContain("Settings");
  });

  it("never implies the FTSA attempt cap is bypassable", async () => {
    orgRows = [{ callingWindowTestModeUntil: expiredHoursAgo(1) }];
    attemptCapAllowed = false;

    const result = await assertOutboundCallAllowed("org-1", "+12125550100");

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("attempt_cap");
    expect(result.reason).not.toContain("test mode");
  });

  it("leaves an allowed result untouched", async () => {
    orgRows = [{ callingWindowTestModeUntil: expiredHoursAgo(3) }];

    const result = await assertOutboundCallAllowed("org-1", "+919876543210");

    expect(result).toEqual({ allowed: true });
  });

  it("reports days once the lapse is older than a day", async () => {
    orgRows = [{ callingWindowTestModeUntil: expiredHoursAgo(50) }];
    numberSeriesAllowed = false;

    const result = await assertOutboundCallAllowed("org-1", "+919876543210");

    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toContain("2 days ago");
  });
});
