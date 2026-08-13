/**
 * ADR-110 — market alignment.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that a misalignment
 * never becomes a refusal, and that an unrecognised vertical or an out-of-scope
 * country is reported as unknown rather than guessed. The whole reason this
 * module is allowed to key off a number prefix is that nothing enforces on its
 * output — so a test that lets an enforcement path grow here is the test that
 * matters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORED_MARKET_BY_VERTICAL,
  checkVerticalMarketAlignment,
  resolveCalleeMarket,
} from "./market-alignment";

describe("resolveCalleeMarket", () => {
  test("recognises India and NANP", () => {
    expect(resolveCalleeMarket("+919876543210")).toBe("india");
    expect(resolveCalleeMarket("+17754554413")).toBe("us");
  });

  /**
   * `checkCallingWindow` folds every non-India number into the US pack because a
   * calling window has to pick some window. Copying that fold here would invent
   * the exact fact this module exists to report, so anything outside the two
   * authored markets is `unknown`.
   */
  test("does not fold the rest of the world into US the way the calling-window resolver does", () => {
    expect(resolveCalleeMarket("+4915112345678")).toBe("unknown");
    expect(resolveCalleeMarket("+442071234567")).toBe("unknown");
  });

  test("rejects malformed and wrong-length numbers rather than part-matching them", () => {
    expect(resolveCalleeMarket("+9198765")).toBe("unknown");
    expect(resolveCalleeMarket("+1775455441")).toBe("unknown");
    expect(resolveCalleeMarket("17754554413")).toBe("unknown");
    expect(resolveCalleeMarket("")).toBe("unknown");
  });
});

describe("checkVerticalMarketAlignment", () => {
  test("insurance is authored for US, shopify for India", () => {
    expect(AUTHORED_MARKET_BY_VERTICAL.insurance).toBe("us");
    expect(AUTHORED_MARKET_BY_VERTICAL.shopify).toBe("india");
  });

  test("aligned calls report the market and nothing else", () => {
    const insuranceUs = checkVerticalMarketAlignment("insurance", "+17754554413");
    expect(insuranceUs).toEqual({ aligned: true, market: "us" });
    const shopifyIndia = checkVerticalMarketAlignment("shopify", "+919876543210");
    expect(shopifyIndia).toEqual({ aligned: true, market: "india" });
  });

  test("insurance dialing India is a mismatch, and names both markets", () => {
    const result = checkVerticalMarketAlignment("insurance", "+919876543210");
    expect(result.aligned).toBe(false);
    if (result.aligned) throw new Error("unreachable");
    expect(result.reason).toBe("market-mismatch");
    expect(result.authoredMarket).toBe("us");
    expect(result.calleeMarket).toBe("india");
    expect(result.message).toContain("US");
    expect(result.message).toContain("INDIA");
  });

  test("shopify dialing the US is a mismatch, not a refusal", () => {
    const result = checkVerticalMarketAlignment("shopify", "+17754554413");
    expect(result.aligned).toBe(false);
    if (result.aligned) throw new Error("unreachable");
    expect(result.reason).toBe("market-mismatch");
    // The message must say the call went through. A merchant reading "mismatch"
    // and assuming the call was blocked is worse than no message.
    expect(result.message).toContain("allowed");
    expect(result.message).toContain("gate still ran");
  });

  /**
   * `orgs.vertical` is `text().notNull()` with no DB enum and no check
   * constraint; only PATCH /api/app/settings validates the two known values, and
   * both org-insert paths (signup, Shopify install) omit it and take the column
   * default. So an unrecognised vertical is reachable, and the honest answer is
   * "no claim on record" rather than a default that asserts a market nobody
   * chose.
   */
  test("an unrecognised vertical is unknown, never defaulted to a market", () => {
    const result = checkVerticalMarketAlignment("dental", "+17754554413");
    expect(result.aligned).toBe(false);
    if (result.aligned) throw new Error("unreachable");
    expect(result.reason).toBe("unknown-vertical");
    expect(result.authoredMarket).toBeNull();
    expect(result.message).toContain("Every vertical-scoped compliance gate still ran");
  });

  test("a destination outside both authored markets is reported as such", () => {
    const result = checkVerticalMarketAlignment("shopify", "+4915112345678");
    expect(result.aligned).toBe(false);
    if (result.aligned) throw new Error("unreachable");
    expect(result.reason).toBe("unknown-callee-market");
    expect(result.calleeMarket).toBe("unknown");
  });

  test("is pure — same inputs, same result, no throw on junk", () => {
    expect(checkVerticalMarketAlignment("shopify", "")).toEqual(
      checkVerticalMarketAlignment("shopify", ""),
    );
  });
});

/**
 * The invariant, asserted against the chokepoint's source because it is a claim
 * about where this module may be called from, not about what it returns.
 *
 * ADR-110's whole trade is that market is a GTM focus decision and not a runtime
 * constraint. The failure mode is somebody later "tightening" this into the gate
 * chain — at which point the first US Shopify merchant is refused by a rule
 * adopted when we had zero customers, and the number-prefix inference (which
 * misclassifies ported/VOIP/diaspora numbers) starts deciding refusals it is not
 * good enough to decide.
 */
describe("market alignment can never refuse a call", () => {
  const gateSource = readFileSync(join(import.meta.dir, "outbound-gate.ts"), "utf8");

  test("it runs on the allowed path and its result is discarded", () => {
    expect(gateSource).toContain("await noteMarketAlignment(orgId, to);");
    // No `allowed: false` may be derived from it.
    expect(gateSource).not.toContain("market_mismatch");
    expect(gateSource).not.toMatch(/gate:\s*"market/);
  });

  test("it is absent from runOutboundGates, which owns the fail-closed decision", () => {
    const runGates = gateSource.slice(
      gateSource.indexOf("async function runOutboundGates("),
      gateSource.indexOf("const TEST_MODE_BYPASSABLE"),
    );
    expect(runGates.length).toBeGreaterThan(200);
    expect(runGates).not.toContain("MarketAlignment");
    expect(runGates).not.toContain("noteMarketAlignment");
  });

  test("it is not listed as a gate a test-mode toggle could lift", () => {
    const bypassable = gateSource.slice(
      gateSource.indexOf("const TEST_MODE_BYPASSABLE"),
      gateSource.indexOf("function formatElapsed"),
    );
    expect(bypassable).not.toContain("market");
  });
});
