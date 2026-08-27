import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Real demo-call widget (2026-08-27) — `isGlobalFlagEnabled` must fail closed on a missing row,
 * since `feature_flags` has 0 production rows as of the 2026-08-25 audit and this flag gates a
 * public endpoint that places real, billed phone calls.
 */

let rows: Array<{ enabled: boolean }> = [];

function thenable(r: unknown[]) {
  const p = Promise.resolve(r) as Promise<unknown[]> & Record<string, unknown>;
  p.where = () => thenable(r);
  p.limit = () => thenable(r);
  return p;
}

mock.module("../database", () => ({
  db: {
    select: () => ({ from: () => thenable(rows) }),
  },
}));

import { isGlobalFlagEnabled } from "./demo-widget-flag";

describe("isGlobalFlagEnabled", () => {
  beforeEach(() => {
    rows = [];
  });

  it("returns false when no row exists (fail closed)", async () => {
    rows = [];
    expect(await isGlobalFlagEnabled("demo-widget-enabled")).toBe(false);
  });

  it("returns true when the row is enabled", async () => {
    rows = [{ enabled: true }];
    expect(await isGlobalFlagEnabled("demo-widget-enabled")).toBe(true);
  });

  it("returns false when the row exists but is disabled", async () => {
    rows = [{ enabled: false }];
    expect(await isGlobalFlagEnabled("demo-widget-enabled")).toBe(false);
  });
});
