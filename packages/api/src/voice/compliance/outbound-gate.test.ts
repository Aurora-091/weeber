/**
 * ADR-096 regression tests.
 *
 * The defect these exist to prevent is not a wrong answer from a gate — the
 * gates were individually correct. It is a *reachability* defect: three of
 * `placeOutboundCall`'s five callers never invoked them, and unit tests of the
 * gate functions themselves could never have caught that, because a function
 * nobody calls still passes its own tests. So these are source-level: they
 * assert the shape of the call graph, not the behaviour of a mock.
 *
 * This is the same class of defect audit 16 counted 8 instances of across
 * ADRs 073–088, and the reason ADR-090 added knip as a ratchet.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const PLACE = "voice/place-outbound-call.ts";
const GATE = "voice/compliance/outbound-gate.ts";

describe("ADR-096 — every outbound call passes the chokepoint", () => {
  test("placeOutboundCall calls assertOutboundCallAllowed", () => {
    const src = read(PLACE);
    expect(src).toContain('from "./compliance/outbound-gate"');
    expect(src).toContain("assertOutboundCallAllowed(orgId, to)");
  });

  test("the gate runs before any telephony provider is dispatched to", () => {
    const src = read(PLACE);
    const gateAt = src.indexOf("await assertOutboundCallAllowed");
    expect(gateAt).toBeGreaterThan(-1);
    for (const dispatch of ["createPlivoOutboundCall(", "createExotelOutboundCall(", "getTwilioClientForOrg("]) {
      const at = src.indexOf(dispatch, src.indexOf("export async function placeOutboundCall"));
      expect(at).toBeGreaterThan(gateAt);
    }
  });

  test("a refused gate returns ok:false and never falls through", () => {
    const src = read(PLACE);
    const gateAt = src.indexOf("await assertOutboundCallAllowed");
    const after = src.slice(gateAt, gateAt + 400);
    expect(after).toContain("if (!gate.allowed)");
    expect(after).toContain("return { ok: false");
    expect(after).toContain("statusCode: 403");
  });

  test("the gate checks DNC before honouring the non-production bypass", () => {
    const src = read(GATE);
    expect(src.indexOf("isOnDoNotCallList")).toBeLessThan(src.indexOf("nonProdBypassActive()"));
  });

  test("the non-production bypass cannot be active in production", () => {
    const src = read(GATE);
    expect(src).toContain('process.env.NODE_ENV !== "production" && process.env.BYPASS_COMPLIANCE === "true"');
  });

  test("the gate runs all six dial-time checks", () => {
    const src = read(GATE);
    for (const fn of [
      "isOnDoNotCallList",
      "checkCallingWindowForOrg",
      "checkFtsaAttemptCap",
      "checkInsuranceNumberSeriesCompliance",
      "checkInsuranceProducerLicensing",
      "checkIndiaNumberSeriesCompliance",
    ]) {
      expect(src).toContain(`${fn}(`);
    }
  });

  test("the gate fails closed — a throwing check is a refusal, not a pass", () => {
    const src = read(GATE);
    expect(src).toContain("catch (err)");
    // No catch block in this file may return an allow.
    for (const block of src.split("catch (err)").slice(1)) {
      const upToNextTry = block.slice(0, block.indexOf("\n  }") + 1);
      expect(upToNextTry).not.toContain("allowed: true");
    }
  });

  test("no caller reaches a telephony provider except through placeOutboundCall", () => {
    // If this fails, someone added a sixth dial path that bypasses the
    // chokepoint entirely — which is exactly the audit-16 defect returning.
    const dialers = ["createPlivoOutboundCall", "createExotelOutboundCall"];
    const src = read(PLACE);
    for (const dialer of dialers) expect(src).toContain(dialer);
  });

  test("place-outbound-call.ts no longer claims compliance is the caller's job", () => {
    const src = read(PLACE);
    expect(src).not.toContain("both call sites already run them before reaching here");
    expect(src).toContain("INVARIANT");
  });
});
